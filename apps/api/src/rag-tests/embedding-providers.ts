import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { decrypt } from '@routers/utils/encryption';
import {
    resolveCredential,
    resolveCollectionCredential,
} from '@routers/rag/credentials';
import { app } from '../app';
import { fixture as f } from './fixtures';

const providers = [
    {
        provider: 'OPENAI' as const,
        model: 'text-embedding-3-small',
        dimensions: 1536,
        read: (id: string) =>
            prisma.openAICredentials.findUniqueOrThrow({ where: { id } }),
        corrupt: (id: string) =>
            prisma.openAICredentials.update({
                where: { id },
                data: { apiKey: 'invalid-ciphertext' },
            }),
    },
    {
        provider: 'MISTRAL' as const,
        model: 'mistral-embed',
        dimensions: 1024,
        read: (id: string) =>
            prisma.mistralCredentials.findUniqueOrThrow({ where: { id } }),
        corrupt: (id: string) =>
            prisma.mistralCredentials.update({
                where: { id },
                data: { apiKey: 'invalid-ciphertext' },
            }),
    },
];

/** Exercise real persistence and HTTP contracts with synthetic secrets; no provider is contacted. */
export async function embeddingProviderTests(t: TestContext) {
    for (const { provider, model, dimensions, read, corrupt } of providers) {
        await t.test(
            `${provider}: encrypted credentials, organization precedence, retained bindings, and isolation`,
            async () => {
                const api = f.owner.rag;
                const prefix = `VECTORIX_DEFAULT_${provider}_`;
                const endpointKey = `${prefix}ENDPOINT`;
                const apiKeyKey = `${prefix}API_KEY`;
                const previous = [
                    process.env[endpointKey],
                    process.env[apiKeyKey],
                ];
                const platformEndpoint = `https://platform-${provider.toLowerCase()}.test/v1`;
                const endpoint = `https://organization-${provider.toLowerCase()}.test/v1`;
                const secret = `${provider}-organization-test-secret`;
                try {
                    process.env[endpointKey] = platformEndpoint;
                    delete process.env[apiKeyKey];
                    await assert.rejects(
                        resolveCredential(prisma, f.org, provider),
                        { code: 'CONFLICT' }
                    );
                    process.env[apiKeyKey] = `${provider}-platform-test-secret`;
                    assert.equal(
                        (await resolveCredential(prisma, f.org, provider))
                            .source,
                        'platform'
                    );
                    const platformCollection = await api.collections.create({
                        name: `${provider} platform`,
                        profile: { provider, model, dimensions },
                    });
                    assert.equal(
                        platformCollection.configuration.credentialId,
                        null
                    );
                    const credential = await api.credentials.create({
                        name: `${provider} organization`,
                        data: { provider, endpoint, apiKey: secret },
                    });
                    const stored = await read(credential.id);
                    assert.notEqual(stored.apiKey, secret);
                    assert.equal(decrypt(stored.apiKey), secret);
                    assert.equal(
                        'apiKey' in credential.data && credential.data.apiKey,
                        '********'
                    );
                    const resolved = await resolveCredential(
                        prisma,
                        f.org,
                        provider
                    );
                    assert.equal(resolved.credentialId, credential.id);
                    assert.equal(resolved.data.endpoint, endpoint);
                    assert.equal(
                        (await resolveCredential(prisma, f.otherOrg, provider))
                            .source,
                        'platform'
                    );
                    assert.equal(
                        (
                            await resolveCollectionCredential(
                                prisma,
                                f.org,
                                platformCollection.id,
                                1
                            )
                        ).source,
                        'platform'
                    );

                    const collection = await api.collections.create({
                        name: `${provider} collection`,
                        profile: { provider, model, dimensions },
                    });
                    assert.equal(collection.configuration.provider, provider);
                    assert.equal(
                        collection.configuration.credentialId,
                        credential.id
                    );
                    assert.equal(
                        collection.configuration.dimensions,
                        dimensions
                    );
                    const response = await app.request(
                        `/api/v1/admin/rag/collections/${collection.id}`,
                        { headers: f.owner.headers() }
                    );
                    assert.equal(response.status, 200);
                    assert.equal(
                        (await response.json()).configuration.provider,
                        provider
                    );
                    await assert.rejects(
                        f.other.rag.collections.get({ id: collection.id }),
                        { code: 'NOT_FOUND' }
                    );
                    await assert.rejects(
                        f.other.rag.credentials.update({
                            id: credential.id,
                            expectedRevision: 1,
                            name: 'Foreign update',
                            data: { provider, endpoint, apiKey: secret },
                        }),
                        { code: 'NOT_FOUND' }
                    );

                    await api.credentials.update({
                        id: credential.id,
                        expectedRevision: 1,
                        name: `${provider} renamed`,
                        data: { provider, endpoint },
                    });
                    assert.equal(
                        (await read(credential.id)).apiKey,
                        stored.apiKey
                    );
                    await api.credentials.update({
                        id: credential.id,
                        expectedRevision: 2,
                        name: `${provider} rotated`,
                        data: {
                            provider,
                            endpoint,
                            apiKey: `${secret}-rotated`,
                        },
                    });
                    const rotated = await resolveCollectionCredential(
                        prisma,
                        f.org,
                        collection.id,
                        1
                    );
                    assert.equal(
                        'apiKey' in rotated.data && rotated.data.apiKey,
                        `${secret}-rotated`
                    );
                    const replacement = await api.credentials.create({
                        name: `${provider} replacement`,
                        data: {
                            provider,
                            endpoint,
                            apiKey: `${secret}-replacement`,
                        },
                    });
                    assert.equal(
                        (await resolveCredential(prisma, f.org, provider))
                            .credentialId,
                        replacement.id
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
                        credential.id
                    );
                    await assert.rejects(
                        api.credentials.delete({
                            id: credential.id,
                            expectedRevision: 3,
                        }),
                        { code: 'CONFLICT' }
                    );
                    const publicData = JSON.stringify({
                        credentials: await api.credentials.list({}),
                        audit: await api.audit({}),
                    });
                    assert.ok(!publicData.includes(secret));
                    assert.ok(!publicData.includes(stored.apiKey));

                    await corrupt(credential.id);
                    await assert.rejects(
                        resolveCollectionCredential(
                            prisma,
                            f.org,
                            collection.id,
                            1
                        ),
                        { code: 'CONFLICT' }
                    );
                    await corrupt(replacement.id);
                    await assert.rejects(
                        resolveCredential(prisma, f.org, provider),
                        { code: 'CONFLICT' }
                    );
                } finally {
                    for (const [index, key] of [
                        endpointKey,
                        apiKeyKey,
                    ].entries()) {
                        const value = previous[index];
                        if (value === undefined) delete process.env[key];
                        else process.env[key] = value;
                    }
                }
            }
        );
    }
}
