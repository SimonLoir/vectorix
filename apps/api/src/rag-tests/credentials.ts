import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { credentialSecretContext, decrypt } from '@routers/utils/encryption';
import { reencryptStoredSecrets } from '@routers/utils/secret-reencryption';
import {
    resolveCredential,
    resolveCollectionCredential,
} from '@routers/rag/credentials';
import { fixture as f, profile } from './fixtures';

export async function credentialTests(t: TestContext) {
    const api = f.owner.rag;
    await t.test(
        'platform fallback is a complete configuration and becomes pinned to the collection',
        async () => {
            const resolved = await resolveCredential(prisma, f.org, 'OLLAMA');
            assert.equal(resolved.source, 'platform');
            const collection = await api.collections.create({
                name: 'Platform binding',
                profile,
            });
            assert.equal(collection.configuration.credentialId, null);
            process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT =
                'http://changed.test:11434';
            await assert.rejects(
                resolveCollectionCredential(prisma, f.org, collection.id, 1),
                { code: 'CONFLICT' }
            );
            process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT =
                'http://platform-ollama.test:11434';
            const credential = await api.credentials.create({
                name: 'Organization Ollama',
                data: {
                    provider: 'OLLAMA',
                    endpoint: 'http://organization-ollama.test:11434',
                    apiKey: 'ollama-test-secret',
                },
            });
            assert.equal(
                credential.data.provider === 'OLLAMA' && credential.data.apiKey,
                '********'
            );
            const stored = await prisma.ollamaCredentials.findUniqueOrThrow({
                where: { id: credential.id },
            });
            assert.notEqual(stored.apiKey, 'ollama-test-secret');
            assert.equal(
                decrypt(
                    stored.apiKey!,
                    credentialSecretContext(f.org, credential.id, 'apiKey')
                ),
                'ollama-test-secret'
            );
            assert.equal(
                (await resolveCredential(prisma, f.org, 'OLLAMA')).credentialId,
                credential.id
            );
            assert.equal(
                (
                    await resolveCollectionCredential(
                        prisma,
                        f.org,
                        collection.id,
                        1
                    )
                ).source,
                'platform'
            );
            assert.equal(
                (await resolveCredential(prisma, f.otherOrg, 'OLLAMA')).source,
                'platform'
            );
        }
    );

    await t.test(
        'all provider types store encrypted secrets and never expose them in DTOs or audit',
        async () => {
            for (const provider of ['COHERE', 'VOYAGE'] as const) {
                const result = await api.credentials.create({
                    name: `${provider} test`,
                    data: {
                        provider,
                        endpoint: `https://${provider.toLowerCase()}.test`,
                        apiKey: `${provider}-test-secret`,
                    },
                });
                const stored =
                    provider === 'COHERE'
                        ? await prisma.cohereCredentials.findUniqueOrThrow({
                              where: { id: result.id },
                          })
                        : await prisma.voyageCredentials.findUniqueOrThrow({
                              where: { id: result.id },
                          });
                assert.equal(
                    decrypt(
                        stored.apiKey,
                        credentialSecretContext(f.org, result.id, 'apiKey')
                    ),
                    `${provider}-test-secret`
                );
                assert.equal(
                    'apiKey' in result.data && result.data.apiKey,
                    '********'
                );
            }
            const s3 = await api.credentials.create({
                name: 'S3 test',
                data: {
                    provider: 'S3',
                    endpoint: 'http://rustfs.test:9000',
                    bucket: 'test-private',
                    region: 'us-east-1',
                    forcePathStyle: true,
                    accessKeyId: 's3-access-secret',
                    secretAccessKey: 's3-secret-value',
                },
            });
            const stored = await prisma.s3Credentials.findUniqueOrThrow({
                where: { id: s3.id },
            });
            assert.equal(
                decrypt(
                    stored.accessKeyId,
                    credentialSecretContext(f.org, s3.id, 'accessKeyId')
                ),
                's3-access-secret'
            );
            assert.equal(
                decrypt(
                    stored.secretAccessKey,
                    credentialSecretContext(f.org, s3.id, 'secretAccessKey')
                ),
                's3-secret-value'
            );
            const response = JSON.stringify({
                credentials: await api.credentials.list({}),
                audit: await api.audit({}),
            });
            for (const secret of [
                'ollama-test-secret',
                'COHERE-test-secret',
                'VOYAGE-test-secret',
                's3-access-secret',
                's3-secret-value',
                stored.accessKeyId,
            ])
                assert.ok(!response.includes(secret));
            await assert.rejects(f.reader.rag.credentials.list({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(
                f.other.rag.credentials.activate({ id: s3.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.other.rag.credentials.delete({
                    id: s3.id,
                    expectedRevision: 1,
                }),
                { code: 'NOT_FOUND' }
            );
            assert.equal((await f.other.rag.credentials.list({})).total, 0);
            await prisma.storageLocation.create({
                data: {
                    organizationId: f.org,
                    credentialId: s3.id,
                    fingerprint: 's3-reference',
                    endpoint: stored.endpoint,
                    bucket: stored.bucket,
                    region: stored.region,
                    forcePathStyle: stored.forcePathStyle,
                },
            });
            await assert.rejects(
                api.credentials.update({
                    id: s3.id,
                    expectedRevision: 1,
                    name: s3.name,
                    data: {
                        provider: 'S3',
                        endpoint: 'http://different.test:9000',
                        bucket: stored.bucket,
                        region: stored.region,
                        forcePathStyle: stored.forcePathStyle,
                    },
                }),
                { code: 'CONFLICT' }
            );
            await assert.rejects(
                api.credentials.delete({ id: s3.id, expectedRevision: 1 }),
                { code: 'CONFLICT' }
            );
        }
    );

    await t.test(
        'selected credentials fail closed; rotation preserves destinations and immutable revisions',
        async () => {
            const original = (
                await api.credentials.list({ query: 'Organization Ollama' })
            ).items[0]!;
            const collection = await api.collections.create({
                name: 'Pinned organization binding',
                profile,
            });
            const next = await api.credentials.create({
                name: 'Replacement Ollama',
                data: {
                    provider: 'OLLAMA',
                    endpoint: 'http://replacement.test:11434',
                    apiKey: null,
                },
            });
            assert.equal(
                (await resolveCredential(prisma, f.org, 'OLLAMA')).credentialId,
                next.id
            );
            assert.equal(
                (
                    await resolveCollectionCredential(
                        prisma,
                        f.org,
                        collection.id,
                        1
                    )
                ).credentialId,
                original.id
            );
            await assert.rejects(
                resolveCollectionCredential(
                    prisma,
                    f.otherOrg,
                    collection.id,
                    1
                ),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                api.credentials.delete({
                    id: original.id,
                    expectedRevision: 1,
                }),
                { code: 'CONFLICT' }
            );
            const sameDestination = {
                provider: 'OLLAMA' as const,
                endpoint: 'http://organization-ollama.test:11434',
            };
            await assert.rejects(
                f.other.rag.credentials.update({
                    id: original.id,
                    expectedRevision: 1,
                    name: 'foreign',
                    data: sameDestination,
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                api.credentials.update({
                    id: original.id,
                    expectedRevision: 1,
                    name: original.name,
                    data: {
                        ...sameDestination,
                        endpoint: 'http://changed.test',
                    },
                }),
                { code: 'CONFLICT' }
            );
            const before = await prisma.ollamaCredentials.findUniqueOrThrow({
                where: { id: original.id },
            });
            const renamed = await api.credentials.update({
                id: original.id,
                expectedRevision: 1,
                name: 'Renamed Ollama',
                data: sameDestination,
            });
            assert.equal(
                (
                    await prisma.ollamaCredentials.findUniqueOrThrow({
                        where: { id: original.id },
                    })
                ).apiKey,
                before.apiKey
            );
            await assert.rejects(
                api.credentials.update({
                    id: original.id,
                    expectedRevision: 1,
                    name: original.name,
                    data: sameDestination,
                }),
                { code: 'CONFLICT' }
            );
            await api.credentials.activate({ id: original.id });
            await prisma.ollamaCredentials.update({
                where: { id: original.id },
                data: { apiKey: 'corrupt-ciphertext' },
            });
            await assert.rejects(resolveCredential(prisma, f.org, 'OLLAMA'), {
                code: 'CONFLICT',
            });
            await assert.rejects(
                api.collections.create({ name: 'Must not fall back', profile }),
                { code: 'CONFLICT' }
            );
            assert.equal(
                await prisma.collection.count({
                    where: {
                        organizationId: f.org,
                        name: 'Must not fall back',
                    },
                }),
                0
            );
            await api.credentials.update({
                id: original.id,
                expectedRevision: renamed.revision,
                name: renamed.name,
                data: { ...sameDestination, apiKey: 'rotated-test-secret' },
            });
            const resolved = await resolveCollectionCredential(
                prisma,
                f.org,
                collection.id,
                1
            );
            assert.equal(
                'apiKey' in resolved.data && resolved.data.apiKey,
                'rotated-test-secret'
            );
            assert.equal(
                (await api.collections.get({ id: collection.id })).configuration
                    .credentialRevision,
                1
            );
            await prisma.credentialSelection.delete({
                where: {
                    ['organizationId_provider']: {
                        organizationId: f.org,
                        provider: 'OLLAMA',
                    },
                },
            });
            await assert.rejects(resolveCredential(prisma, f.org, 'OLLAMA'), {
                code: 'CONFLICT',
            });
            await api.credentials.activate({ id: original.id });
            // Deleting an unused credential is permitted and audited.
            await api.credentials.delete({
                id: next.id,
                expectedRevision: next.revision,
            });
        }
    );

    await t.test(
        'legacy, swapped and retired-key secrets are bound to their rows and re-encrypted idempotently',
        async () => {
            const original = process.env.ENCRYPTION_SECRET!;
            const legacy = (plaintext: string) => {
                const iv = crypto.randomBytes(16);
                const cipher = crypto.createCipheriv(
                    'aes-256-gcm',
                    Buffer.from(original, 'hex'),
                    iv
                );
                const data =
                    cipher.update(plaintext, 'utf8', 'hex') +
                    cipher.final('hex');
                return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
            };
            const create = (name: string, apiKey: string) =>
                api.credentials.create({
                    name,
                    data: {
                        provider: 'COHERE',
                        endpoint: 'https://cohere-rotation.test',
                        apiKey,
                    },
                    activate: false,
                });
            const resolve = async (id: string) => {
                const stored = await prisma.credentials.findUniqueOrThrow({
                    where: { id },
                    include: { cohere: true },
                });
                return decrypt(
                    stored.cohere!.apiKey,
                    credentialSecretContext(f.org, id, 'apiKey')
                );
            };
            const a = await create('Rotation A', 'rotation-a-secret');
            const b = await create('Rotation B', 'rotation-b-secret');
            const sealedA = (
                await prisma.cohereCredentials.findUniqueOrThrow({
                    where: { id: a.id },
                })
            ).apiKey;
            assert.match(sealedA, /^v2:/u);
            // A ciphertext copied to another row no longer decrypts there.
            await prisma.cohereCredentials.update({
                where: { id: b.id },
                data: { apiKey: sealedA },
            });
            assert.throws(() =>
                decrypt(sealedA, credentialSecretContext(f.org, b.id, 'apiKey'))
            );
            // Legacy rows written before v2 remain readable, then migrate.
            await prisma.cohereCredentials.update({
                where: { id: b.id },
                data: { apiKey: legacy('rotation-b-legacy') },
            });
            assert.equal(await resolve(b.id), 'rotation-b-legacy');
            const next = 'c3'.repeat(32);
            const previous = process.env.ENCRYPTION_PREVIOUS_SECRETS;
            try {
                process.env.ENCRYPTION_SECRET = next;
                process.env.ENCRYPTION_PREVIOUS_SECRETS = original;
                assert.equal(await resolve(a.id), 'rotation-a-secret');
                const dry = await reencryptStoredSecrets(prisma, {
                    dryRun: true,
                });
                assert.ok(dry.columns.cohereCredentials!.wouldReencrypt >= 2);
                assert.match(
                    (
                        await prisma.cohereCredentials.findUniqueOrThrow({
                            where: { id: b.id },
                        })
                    ).apiKey,
                    /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/u
                );
                const report = await reencryptStoredSecrets(prisma, {
                    batchSize: 2,
                });
                assert.ok(report.columns.cohereCredentials!.reencrypted >= 2);
                assert.equal(report.status, 'COMPLETE');
                const again = await reencryptStoredSecrets(prisma);
                assert.equal(again.status, 'COMPLETE');
                for (const counts of Object.values(again.columns))
                    assert.equal(counts.reencrypted, 0);
                delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
                assert.equal(await resolve(a.id), 'rotation-a-secret');
                assert.equal(await resolve(b.id), 'rotation-b-legacy');
            } finally {
                // Rotate every row back so later suites keep reading with the original key.
                process.env.ENCRYPTION_SECRET = original;
                process.env.ENCRYPTION_PREVIOUS_SECRETS = next;
                await reencryptStoredSecrets(prisma);
                if (previous === undefined)
                    delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
                else process.env.ENCRYPTION_PREVIOUS_SECRETS = previous;
            }
            assert.equal(await resolve(a.id), 'rotation-a-secret');
            for (const id of [a.id, b.id]) {
                const { revision } = await prisma.credentials.findUniqueOrThrow(
                    {
                        where: { id },
                    }
                );
                await api.credentials.delete({
                    id,
                    expectedRevision: revision,
                });
            }
        }
    );

    await t.test(
        'changing endpoint, bucket, or S3 addressing mode requires re-entering secrets',
        async () => {
            const cohere = await api.credentials.create({
                name: 'Destination Cohere',
                data: {
                    provider: 'COHERE',
                    endpoint: 'https://cohere-a.test',
                    apiKey: 'destination-cohere-secret',
                },
                activate: false,
            });
            const storedKey = async () =>
                (
                    await prisma.cohereCredentials.findUniqueOrThrow({
                        where: { id: cohere.id },
                    })
                ).apiKey;
            const before = await storedKey();
            await assert.rejects(
                api.credentials.update({
                    id: cohere.id,
                    expectedRevision: cohere.revision,
                    name: cohere.name,
                    data: {
                        provider: 'COHERE',
                        endpoint: 'https://cohere-b.test',
                    },
                }),
                { code: 'BAD_REQUEST' }
            );
            assert.equal(await storedKey(), before);
            assert.equal(
                (
                    await prisma.credentials.findUniqueOrThrow({
                        where: { id: cohere.id },
                    })
                ).revision,
                cohere.revision
            );
            const moved = await api.credentials.update({
                id: cohere.id,
                expectedRevision: cohere.revision,
                name: cohere.name,
                data: {
                    provider: 'COHERE',
                    endpoint: 'https://cohere-b.test',
                    apiKey: 'destination-cohere-reentered',
                },
            });
            assert.equal(
                decrypt(
                    await storedKey(),
                    credentialSecretContext(f.org, cohere.id, 'apiKey')
                ),
                'destination-cohere-reentered'
            );
            const entries = await prisma.ragAuditLog.findMany({
                where: {
                    organizationId: f.org,
                    action: 'credential.update',
                    targetId: cohere.id,
                },
                orderBy: { createdAt: 'asc' },
            });
            assert.deepEqual(entries.at(-1)?.details, {
                revision: moved.revision,
                destinationChanged: true,
            });
            assert.ok(!JSON.stringify(entries).includes('cohere-b.test'));

            const s3Data = {
                provider: 'S3' as const,
                endpoint: 'http://rustfs-destination.test:9000',
                bucket: 'destination-a',
                region: 'us-east-1',
                forcePathStyle: true,
            };
            const s3 = await api.credentials.create({
                name: 'Destination S3',
                data: {
                    ...s3Data,
                    accessKeyId: 'destination-access',
                    secretAccessKey: 'destination-secret',
                },
                activate: false,
            });
            const s3Before = await prisma.s3Credentials.findUniqueOrThrow({
                where: { id: s3.id },
            });
            for (const destination of [
                { endpoint: 'http://rustfs-other-destination.test:9000' },
                { bucket: 'destination-b' },
                { forcePathStyle: false },
            ]) {
                for (const partial of [
                    {},
                    { secretAccessKey: 'only-the-secret' },
                    { accessKeyId: 'only-the-access-key' },
                ])
                    await assert.rejects(
                        api.credentials.update({
                            id: s3.id,
                            expectedRevision: s3.revision,
                            name: s3.name,
                            data: {
                                ...s3Data,
                                ...destination,
                                ...partial,
                            },
                        }),
                        { code: 'BAD_REQUEST' }
                    );
            }
            const rejectedS3 = await prisma.s3Credentials.findUniqueOrThrow({
                where: { id: s3.id },
            });
            assert.ok(JSON.stringify(rejectedS3) === JSON.stringify(s3Before));
            assert.equal(
                (
                    await prisma.credentials.findUniqueOrThrow({
                        where: { id: s3.id },
                    })
                ).revision,
                s3.revision
            );
            assert.equal(
                await prisma.ragAuditLog.count({
                    where: {
                        organizationId: f.org,
                        action: 'credential.update',
                        targetId: s3.id,
                    },
                }),
                0
            );
            // Region alone keeps the explicitly configured request destination.
            const regional = await api.credentials.update({
                id: s3.id,
                expectedRevision: s3.revision,
                name: s3.name,
                data: { ...s3Data, region: 'eu-west-1' },
            });
            const addressed = await api.credentials.update({
                id: s3.id,
                expectedRevision: regional.revision,
                name: s3.name,
                data: {
                    ...s3Data,
                    region: 'eu-west-1',
                    forcePathStyle: false,
                    accessKeyId: 'destination-access-reentered',
                    secretAccessKey: 'destination-secret-reentered',
                },
            });
            await api.credentials.update({
                id: s3.id,
                expectedRevision: addressed.revision,
                name: s3.name,
                data: {
                    ...s3Data,
                    bucket: 'destination-b',
                    accessKeyId: 'destination-access-2',
                    secretAccessKey: 'destination-secret-2',
                },
            });

            const keyless = await api.credentials.create({
                name: 'Destination keyless Ollama',
                data: {
                    provider: 'OLLAMA',
                    endpoint: 'http://ollama-a.test:11434',
                    apiKey: null,
                },
                activate: false,
            });
            await api.credentials.update({
                id: keyless.id,
                expectedRevision: keyless.revision,
                name: keyless.name,
                data: {
                    provider: 'OLLAMA',
                    endpoint: 'http://ollama-b.test:11434',
                },
            });
            const keyed = await api.credentials.create({
                name: 'Destination keyed Ollama',
                data: {
                    provider: 'OLLAMA',
                    endpoint: 'http://ollama-a.test:11434',
                    apiKey: 'destination-ollama-secret',
                },
                activate: false,
            });
            await assert.rejects(
                api.credentials.update({
                    id: keyed.id,
                    expectedRevision: keyed.revision,
                    name: keyed.name,
                    data: {
                        provider: 'OLLAMA',
                        endpoint: 'http://ollama-b.test:11434',
                    },
                }),
                { code: 'BAD_REQUEST' }
            );
            // Removing the key while moving sends no stored secret anywhere.
            await api.credentials.update({
                id: keyed.id,
                expectedRevision: keyed.revision,
                name: keyed.name,
                data: {
                    provider: 'OLLAMA',
                    endpoint: 'http://ollama-b.test:11434',
                    apiKey: null,
                },
            });
            assert.equal(
                (
                    await prisma.ollamaCredentials.findUniqueOrThrow({
                        where: { id: keyed.id },
                    })
                ).apiKey,
                null
            );
            for (const id of [cohere.id, s3.id, keyless.id, keyed.id]) {
                const { revision } = await prisma.credentials.findUniqueOrThrow(
                    {
                        where: { id },
                    }
                );
                await api.credentials.delete({
                    id,
                    expectedRevision: revision,
                });
            }
        }
    );
}
