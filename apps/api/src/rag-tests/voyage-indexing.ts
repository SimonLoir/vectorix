import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { verifiedEmbedding } from '@repo/api-contracts/v1/rag/indexing-types';
import { fixture as f, rpc } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';
import {
    createCohereHttpFixture,
    COHERE_ORGANIZATION_KEY,
} from './cohere-fixtures';
import {
    createVoyageHttpFixture,
    waitForVoyageRequest,
    VOYAGE_ORGANIZATION_KEY,
    VOYAGE_PLATFORM_KEY,
    VOYAGE_ROTATED_KEY,
} from './voyage-fixtures';
import { app } from '../app';

/** Only public diagnostics may survive a failed native call; never provider bodies or recoverable secrets. */
function failure(code: string) {
    return (error: unknown) => {
        assert(error && typeof error === 'object' && 'data' in error);
        assert.deepEqual(error.data, { errorCode: code });
        const encoded = JSON.stringify(error);
        for (const secret of [
            VOYAGE_ORGANIZATION_KEY,
            VOYAGE_PLATFORM_KEY,
            VOYAGE_ROTATED_KEY,
            'private-voyage-provider-body',
        ])
            assert(!encoded.includes(secret));
        return true;
    };
}

/** Controlled native Voyage + actual catalog/vector/object storage; this never claims hosted model connectivity or relevance. */
export async function voyageIndexingTests(t: TestContext) {
    const previous = {
        organization: f.org,
        owner: f.ownerMember,
        manager: f.managerMember,
    };
    const organization = await f.owner.post('organization/create', {
        name: `Voyage isolation ${randomUUID()}`,
        slug: `voyage-${randomUUID()}`,
    });
    await f.owner.post('organization/set-active', {
        organizationId: organization.id,
    });
    f.org = organization.id;
    f.ownerMember = (await f.owner.client.admin.members.me({})).id;
    const manager = await prisma.member.create({
        data: {
            id: randomUUID(),
            organizationId: f.org,
            userId: f.users[3]!,
            role: 'admin',
            createdAt: new Date(),
        },
    });
    f.managerMember = manager.id;
    await f.manager.post('organization/set-active', { organizationId: f.org });
    const fixture = await createIndexingFixture();
    const voyage = await createVoyageHttpFixture();
    const cohere = await createCohereHttpFixture();
    const environment = {
        endpoint: process.env.VECTORIX_DEFAULT_VOYAGE_ENDPOINT,
        key: process.env.VECTORIX_DEFAULT_VOYAGE_API_KEY,
    };
    process.env.VECTORIX_DEFAULT_VOYAGE_ENDPOINT = voyage.endpoint;
    process.env.VECTORIX_DEFAULT_VOYAGE_API_KEY = VOYAGE_PLATFORM_KEY;
    process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = `${fixture.endpoint},${cohere.endpoint},${voyage.endpoint}`;
    const nativeProfile = {
        provider: 'VOYAGE' as const,
        model: 'voyage-4',
        dimensions: 256,
        embeddingPreset: 'GENERIC' as const,
        preparation: 'Literal Voyage preparation.',
    };
    async function draft(
        id: string,
        overrides: Partial<typeof collectionProfile._output>
    ) {
        const current = await f.owner.rag.collections.get({ id });
        return f.owner.rag.collections.update({
            id,
            expectedRevision: current.configurationRevision,
            name: current.name,
            description: current.description,
            profile: {
                ...collectionProfile.strip().parse(current.configuration),
                ...overrides,
            },
        });
    }
    try {
        const platform = await f.owner.rag.collections.create({
            name: 'Voyage platform binding',
            profile: nativeProfile,
            grantCreatorRead: true,
        });
        assert.equal(platform.configuration.credentialId, null);
        const credential = await f.owner.rag.credentials.create({
            name: 'Voyage organization binding',
            data: {
                provider: 'VOYAGE',
                endpoint: voyage.endpoint,
                apiKey: VOYAGE_ORGANIZATION_KEY,
            },
        });
        const collection = await f.owner.rag.collections.create({
            name: 'Native Voyage passages',
            profile: {
                ...nativeProfile,
                chunking: {
                    targetTokens: 32,
                    overlapTokens: 0,
                    minTokens: 1,
                    maxTokens: 32,
                },
            },
            grantCreatorRead: true,
        });
        const collectionId = collection.id;
        assert.equal(collection.configuration.credentialId, credential.id);
        let revision = collection.configurationRevision;
        let activeId = '';
        let sourceReceipt = '';
        const frenchText =
            '# Needle\nneedle-voyage désigne le passage exact recherché.\n\n# Middle\nOrdinary forests and foxes surround this middle reference.\n\n# Last\nOrdinary solar panels provide the final reference.\n';
        const french = await fixture.upload(
            frenchText,
            'voyage-fr.md',
            collectionId
        );
        const english = await fixture.upload(
            'English context: solar energy powers a sustainable future.\n',
            'voyage-en.txt',
            collectionId
        );
        const query = {
            collectionId,
            query: 'needle-voyage',
            strategy: 'VECTOR' as const,
            topK: 1,
            filters: {},
        };

        await t.test(
            'Voyage reviewed catalog makes no native calls or availability claim, and optional metadata preserves older probe DTOs',
            async () => {
                const before = voyage.state.calls.length;
                const listed = await f.owner.rag.indexing.models({
                    collectionId,
                    expectedRevision: revision,
                });
                assert.deepEqual(
                    new Set(listed.items.map((item) => item.model)),
                    new Set(['voyage-4', 'voyage-4-lite', 'voyage-4-large'])
                );
                assert.equal(listed.reviewedCatalog, true);
                assert.equal(listed.discoverySource, undefined);
                assert.equal(voyage.state.calls.length, before);
                assert(
                    listed.items.every(
                        (item) => item.identityKind === 'CAPABILITY_PROFILE'
                    )
                );
                const oldDto = verifiedEmbedding.parse({
                    provider: 'OLLAMA',
                    model: 'fixture:latest',
                    digest: 'a'.repeat(64),
                    family: 'bert',
                    contextTokens: 2048,
                    dimensions: 3,
                    defaultDimensions: 3,
                    supportedDimensions: [3],
                    preset: 'GENERIC',
                });
                assert.equal(oldDto.reviewedCatalog, undefined);
                assert.equal(oldDto.discoverySource, undefined);
            }
        );

        await t.test(
            'Voyage native probes distinguish document/query roles, validate all dimensions and reject malformed indexed responses before generation acceptance',
            async () => {
                for (const dimensions of [256, 512, 1024, 2048]) {
                    if (dimensions !== 256)
                        revision = (await draft(collectionId, { dimensions }))
                            .configurationRevision;
                    const before = voyage.state.calls.length;
                    const probed = await f.owner.rag.indexing.probe({
                        collectionId,
                        expectedRevision: revision,
                    });
                    assert.equal(probed.provider, 'VOYAGE');
                    assert.equal(probed.model, 'voyage-4');
                    assert.equal(probed.identityKind, 'CAPABILITY_PROFILE');
                    assert.equal(probed.reviewedCatalog, true);
                    assert.equal(probed.discoverySource, undefined);
                    assert.equal(probed.dimensions, dimensions);
                    assert.deepEqual(
                        probed.supportedDimensions,
                        [256, 512, 1024, 2048]
                    );
                    const calls = voyage.state.calls.slice(before);
                    assert.deepEqual(
                        new Set(calls.map((call) => call.body.input_type)),
                        new Set(['document', 'query'])
                    );
                    for (const call of calls) {
                        assert.equal(call.path, '/v1/embeddings');
                        assert.equal(
                            call.authorization,
                            `Bearer ${VOYAGE_ORGANIZATION_KEY}`
                        );
                        assert.equal(call.body.output_dimension, dimensions);
                        assert.equal(call.body.output_dtype, 'float');
                        assert.equal(call.body.truncation, false);
                        assert(
                            call.body.encoding_format === undefined ||
                                call.body.encoding_format === null
                        );
                        assert(
                            call.body.input?.every((text) =>
                                text.startsWith(
                                    `${nativeProfile.preparation}\n`
                                )
                            )
                        );
                        assert(
                            call.body.input?.every(
                                (text) =>
                                    !text.includes(
                                        'Represent the query for retrieving supporting documents:'
                                    )
                            )
                        );
                    }
                }
                for (const model of ['voyage-4-lite', 'voyage-4-large']) {
                    revision = (
                        await draft(collectionId, { model, dimensions: 256 })
                    ).configurationRevision;
                    assert.equal(
                        (
                            await f.owner.rag.indexing.probe({
                                collectionId,
                                expectedRevision: revision,
                            })
                        ).model,
                        model
                    );
                }
                revision = (await draft(collectionId, { model: 'voyage-4' }))
                    .configurationRevision;
                await assert.rejects(
                    f.owner.rag.indexing.models({
                        collectionId,
                        expectedRevision: 1,
                    }),
                    failure('MODEL_CHANGED')
                );
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId,
                        expectedRevision: 1,
                    }),
                    failure('MODEL_CHANGED')
                );
                const invalid = await f.owner.rag.collections.create({
                    name: 'Invalid Voyage dimensions',
                    profile: { ...nativeProfile, dimensions: 255 },
                });
                const beforeInvalid = voyage.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.start({
                        collectionId: invalid.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    }),
                    failure('DIMENSIONS_UNSUPPORTED')
                );
                assert.equal(voyage.state.calls.length, beforeInvalid);
                voyage.state.invalidIndex = true;
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.start({
                            collectionId,
                            expectedRevision: revision,
                            requestId: randomUUID(),
                        }),
                        failure('INVALID_PROVIDER_RESPONSE')
                    );
                } finally {
                    voyage.state.invalidIndex = false;
                }
                voyage.state.invalidDimensions = true;
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.probe({
                            collectionId,
                            expectedRevision: revision,
                        }),
                        failure('INVALID_PROVIDER_RESPONSE')
                    );
                } finally {
                    voyage.state.invalidDimensions = false;
                }
                assert.equal(
                    await prisma.indexGeneration.count({
                        where: { collectionId },
                    }),
                    0
                );
            }
        );

        await t.test(
            'Voyage reversed native response rows retain exact vector-to-passage association and immutable FR/EN sources',
            async () => {
                activeId = (
                    await f.owner.rag.indexing.start({
                        collectionId,
                        expectedRevision: revision,
                        requestId: randomUUID(),
                    })
                ).generationId;
                await fixture.scan(8);
                const status = await f.owner.rag.indexing.status({
                    collectionId,
                });
                assert.equal(status.active?.id, activeId);
                assert.equal(status.unsupportedReason, null);
                assert.equal(status.usage.reservedChunks, 0);
                assert(
                    voyage.state.calls.some(
                        (call) =>
                            call.body.input_type === 'document' &&
                            (call.body.input?.length ?? 0) > 1
                    )
                );
                const result = await f.owner.rag.indexing.search(query);
                assert.equal(result.generationId, activeId);
                assert.equal(result.results.length, 1);
                assert.equal(result.results[0]!.documentId, french.id);
                assert(result.results[0]!.text.includes('needle-voyage'));
                assert.equal(result.results[0]!.scores.vectorDistance, 0);
                sourceReceipt = result.results[0]!.source.receipt;
                assert(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text.includes('needle-voyage')
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text(),
                    frenchText
                );
                const filtered = await f.owner.rag.indexing.search({
                    ...query,
                    filters: { documentIds: [english.id] },
                });
                assert.equal(filtered.results[0]!.documentId, english.id);
                const generation =
                    await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: activeId },
                    });
                const snapshot = generation.capabilitySnapshot;
                assert(
                    snapshot &&
                        typeof snapshot === 'object' &&
                        !Array.isArray(snapshot)
                );
                assert.equal(snapshot.schemaVersion, 3);
                assert.equal(snapshot.provider, 'VOYAGE');
                assert.equal(snapshot.identityKind, 'CAPABILITY_PROFILE');
                assert.equal(snapshot.digest, generation.modelIdentity);
                const rest = await app.request(
                    `/api/v1/admin/rag/collections/${collectionId}/search`,
                    {
                        method: 'POST',
                        headers: {
                            ...f.owner.headers(),
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify(query),
                    }
                );
                assert.equal(rest.status, 200);
                assert.equal(rest.headers.get('Vectorix-API-Revision'), '12');
                assert.equal(
                    (await rest.json()).results[0].id,
                    result.results[0]!.id
                );
            }
        );

        await t.test(
            'Voyage local listing never verifies a bad organization key, saved bindings survive rotation and invalid configured credentials cannot use the platform fallback',
            async () => {
                await f.owner.rag.indexing.probe({
                    collectionId: platform.id,
                    expectedRevision: 1,
                });
                const platformCalls = voyage.platformCalls();
                assert(platformCalls > 0);
                await f.owner.rag.credentials.update({
                    id: credential.id,
                    expectedRevision: 1,
                    name: credential.name,
                    data: {
                        provider: 'VOYAGE',
                        endpoint: voyage.endpoint,
                        apiKey: VOYAGE_ROTATED_KEY,
                    },
                });
                const rotatedAt = voyage.state.calls.length;
                await f.owner.rag.indexing.search(query);
                assert(
                    voyage.state.calls
                        .slice(rotatedAt)
                        .every(
                            (call) =>
                                call.authorization ===
                                `Bearer ${VOYAGE_ROTATED_KEY}`
                        )
                );
                await f.owner.rag.credentials.create({
                    name: 'Invalid Voyage key',
                    data: {
                        provider: 'VOYAGE',
                        endpoint: voyage.endpoint,
                        apiKey: 'invalid-synthetic-key',
                    },
                });
                const broken = await f.owner.rag.collections.create({
                    name: 'Broken Voyage key',
                    profile: nativeProfile,
                });
                const before = voyage.state.calls.length;
                const listed = await f.owner.rag.indexing.models({
                    collectionId: broken.id,
                });
                assert.equal(listed.reviewedCatalog, true);
                assert.equal(voyage.state.calls.length, before);
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: broken.id,
                        expectedRevision: 1,
                    }),
                    failure('PROVIDER_REJECTED')
                );
                await assert.rejects(
                    f.owner.rag.indexing.start({
                        collectionId: broken.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    }),
                    failure('PROVIDER_REJECTED')
                );
                assert.equal(voyage.platformCalls(), platformCalls);
                assert.equal(
                    await prisma.indexGeneration.count({
                        where: { collectionId: broken.id },
                    }),
                    0
                );
                assert.equal(
                    (await f.owner.rag.indexing.search(query)).generationId,
                    activeId
                );
                const deniedCredential = await f.owner.rag.credentials.create({
                    name: 'Unapproved Voyage destination',
                    data: {
                        provider: 'VOYAGE',
                        endpoint: `${voyage.endpoint}/unapproved`,
                        apiKey: VOYAGE_ORGANIZATION_KEY,
                    },
                });
                const denied = await f.owner.rag.collections.create({
                    name: 'Unapproved Voyage endpoint',
                    profile: nativeProfile,
                });
                assert.equal(
                    denied.configuration.credentialId,
                    deniedCredential.id
                );
                const requestCount = voyage.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: denied.id,
                        expectedRevision: 1,
                    }),
                    failure('CREDENTIALS_INVALID')
                );
                assert.equal(voyage.state.calls.length, requestCount);
                await f.owner.rag.credentials.activate({ id: credential.id });
            }
        );

        await t.test(
            'Voyage retrieval uses current collection grants and key scopes after native query I/O',
            async () => {
                const before = voyage.state.calls.length;
                await assert.rejects(
                    f.other.rag.indexing.probe({
                        collectionId,
                        expectedRevision: revision,
                    })
                );
                await assert.rejects(
                    f.manager.rag.indexing.probe({
                        collectionId,
                        expectedRevision: revision,
                    })
                );
                assert.equal(voyage.state.calls.length, before);
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Voyage search only',
                        permissions: {
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                        },
                        collectionScopes: [
                            {
                                collectionId,
                                read: true,
                                manageDocuments: false,
                            },
                        ],
                    });
                const api = rpc(() => ({ 'x-api-key': key.key })).admin.rag
                    .indexing;
                await assert.rejects(
                    api.probe({ collectionId, expectedRevision: revision }),
                    { code: 'FORBIDDEN' }
                );
                const entered = Promise.withResolvers<void>();
                const released = Promise.withResolvers<void>();
                voyage.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = api.search(query).then(
                    () => null,
                    (error: unknown) => error
                );
                try {
                    await waitForVoyageRequest(entered.promise);
                    await f.owner.rag.collections.setGrant({
                        id: collectionId,
                        target: { type: 'member', id: f.ownerMember },
                        permissions: {
                            read: false,
                            manageDocuments: true,
                            administer: true,
                        },
                    });
                } finally {
                    delete voyage.state.beforeEmbedding;
                    released.resolve();
                }
                const denied = await inFlight;
                assert(
                    denied &&
                        typeof denied === 'object' &&
                        'code' in denied &&
                        ['NOT_FOUND', 'FORBIDDEN'].includes(String(denied.code))
                );
                await assert.rejects(
                    api.sourceOriginal({ collectionId, receipt: sourceReceipt })
                );
                await f.owner.rag.collections.setGrant({
                    id: collectionId,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: true,
                    },
                });
            }
        );

        await t.test(
            'a captured Cohere query and exact source survive a failed Voyage successor and explicit retry to schema-three activation',
            async () => {
                await f.owner.rag.credentials.create({
                    name: 'Legacy Cohere',
                    data: {
                        provider: 'COHERE',
                        endpoint: cohere.endpoint,
                        apiKey: COHERE_ORGANIZATION_KEY,
                    },
                });
                const legacy = await f.owner.rag.collections.create({
                    name: 'Cohere to Voyage',
                    profile: {
                        provider: 'COHERE',
                        model: 'embed-v4.0',
                        dimensions: 256,
                    },
                    grantCreatorRead: true,
                });
                const text =
                    'Cross-provider context: protected forests shelter foxes.\n';
                await fixture.upload(
                    text,
                    'voyage-rebuild-source.txt',
                    legacy.id
                );
                const first = await f.owner.rag.indexing.start({
                    collectionId: legacy.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await fixture.scan(6);
                const search = {
                    ...query,
                    collectionId: legacy.id,
                    query: 'context',
                    strategy: 'HYBRID' as const,
                };
                const entered = Promise.withResolvers<void>();
                const released = Promise.withResolvers<void>();
                cohere.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = f.owner.rag.indexing.search(search).then(
                    (result) => ({ result }),
                    (error: unknown) => ({ error })
                );
                try {
                    await waitForVoyageRequest(entered.promise);
                    delete cohere.state.beforeEmbedding;
                    const changed = await draft(legacy.id, nativeProfile);
                    const candidate = await f.owner.rag.indexing.rebuild({
                        collectionId: legacy.id,
                        expectedRevision: changed.configurationRevision,
                        expectedActiveGenerationId: first.generationId,
                        requestId: randomUUID(),
                    });
                    voyage.state.rejectEmbeddings = true;
                    await fixture.scan(3);
                    assert.equal(
                        (await f.owner.rag.indexing.search(search))
                            .generationId,
                        first.generationId
                    );
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId: candidate.generationId,
                            kind: 'INDEX_DOCUMENT',
                            status: 'PENDING',
                        },
                    });
                    await prisma.indexTask.update({
                        where: { id: task.id },
                        data: { attempts: 4, availableAt: new Date(0) },
                    });
                    await fixture.scan(1);
                    assert.equal(
                        (
                            await prisma.indexTask.findUniqueOrThrow({
                                where: { id: task.id },
                            })
                        ).status,
                        'FAILED'
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: legacy.id,
                            })
                        ).active?.id,
                        first.generationId
                    );
                    voyage.state.rejectEmbeddings = false;
                    await f.owner.rag.indexing.retry({
                        collectionId: legacy.id,
                        taskId: task.id,
                    });
                    await fixture.scan(6);
                    assert.equal(
                        (await f.owner.rag.indexing.search(search))
                            .generationId,
                        candidate.generationId
                    );
                    const old = await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: first.generationId },
                    });
                    assert.equal(old.status, 'RETIRED');
                    assert(
                        old.capabilitySnapshot &&
                            typeof old.capabilitySnapshot === 'object' &&
                            !Array.isArray(old.capabilitySnapshot)
                    );
                    assert.equal(old.capabilitySnapshot.schemaVersion, 2);
                    assert.equal(old.capabilitySnapshot.provider, 'COHERE');
                } finally {
                    delete cohere.state.beforeEmbedding;
                    voyage.state.rejectEmbeddings = false;
                    released.resolve();
                }
                const captured = await inFlight;
                if ('error' in captured) throw captured.error;
                assert.equal(captured.result.generationId, first.generationId);
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: legacy.id,
                            receipt: captured.result.results[0]!.source.receipt,
                        })
                    ).text(),
                    text
                );
            }
        );
    } finally {
        await voyage.close();
        await cohere.close();
        if (environment.endpoint === undefined)
            delete process.env.VECTORIX_DEFAULT_VOYAGE_ENDPOINT;
        else
            process.env.VECTORIX_DEFAULT_VOYAGE_ENDPOINT = environment.endpoint;
        if (environment.key === undefined)
            delete process.env.VECTORIX_DEFAULT_VOYAGE_API_KEY;
        else process.env.VECTORIX_DEFAULT_VOYAGE_API_KEY = environment.key;
        await fixture.close();
        f.org = previous.organization;
        f.ownerMember = previous.owner;
        f.managerMember = previous.manager;
        await f.owner.post('organization/set-active', {
            organizationId: f.org,
        });
        await f.manager.post('organization/set-active', {
            organizationId: f.org,
        });
    }
}
