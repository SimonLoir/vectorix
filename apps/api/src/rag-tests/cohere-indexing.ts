import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { app } from '../app';
import { fixture as f, rpc } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';
import {
    createCohereHttpFixture,
    waitForCohereRequest,
    COHERE_ORGANIZATION_KEY,
    COHERE_PLATFORM_KEY,
    COHERE_ROTATED_KEY,
} from './cohere-fixtures';

/** Assert only stable public diagnostics; synthetic provider text and credentials must never escape. */
function failure(code: string) {
    return (error: unknown) => {
        assert(error && typeof error === 'object' && 'data' in error);
        assert.deepEqual(error.data, { errorCode: code });
        const serialized = JSON.stringify(error);
        for (const secret of [
            COHERE_ORGANIZATION_KEY,
            COHERE_PLATFORM_KEY,
            COHERE_ROTATED_KEY,
            'private-cohere-error-body',
        ])
            assert(!serialized.includes(secret));
        return true;
    };
}

/** Real application/vector/object persistence with a controlled native Cohere server; no hosted-provider quality claim. */
export async function cohereIndexingTests(t: TestContext) {
    const previousOrganization = {
        id: f.org,
        owner: f.ownerMember,
        manager: f.managerMember,
    };
    const organization = await f.owner.post('organization/create', {
        name: `Cohere isolation ${randomUUID()}`,
        slug: `cohere-${randomUUID()}`,
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
    const cohere = await createCohereHttpFixture();
    const priorEnvironment = {
        endpoint: process.env.VECTORIX_DEFAULT_COHERE_ENDPOINT,
        key: process.env.VECTORIX_DEFAULT_COHERE_API_KEY,
    };
    process.env.VECTORIX_DEFAULT_COHERE_ENDPOINT = cohere.endpoint;
    process.env.VECTORIX_DEFAULT_COHERE_API_KEY = COHERE_PLATFORM_KEY;
    process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = `${fixture.endpoint},${cohere.endpoint}`;
    const nativeProfile = {
        provider: 'COHERE' as const,
        model: 'embed-v4.0',
        dimensions: 256,
        embeddingPreset: 'GENERIC' as const,
        preparation: 'Literal collection preparation.',
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
            name: `Cohere platform binding ${randomUUID()}`,
            profile: nativeProfile,
            grantCreatorRead: true,
        });
        assert.equal(platform.configuration.credentialId, null);
        const credential = await f.owner.rag.credentials.create({
            name: 'Cohere organization binding',
            data: {
                provider: 'COHERE',
                endpoint: cohere.endpoint,
                apiKey: COHERE_ORGANIZATION_KEY,
            },
        });
        const collection = await f.owner.rag.collections.create({
            name: `Native Cohere ${randomUUID()}`,
            profile: nativeProfile,
            grantCreatorRead: true,
        });
        const collectionId = collection.id;
        assert.equal(collection.configuration.credentialId, credential.id);
        let revision = collection.configurationRevision;
        let activeId = '';
        let sourceReceipt = '';
        const frenchText =
            'Contexte français : les renards vivent dans les forêts.\n';
        const englishText =
            'English context: solar energy powers a sustainable future.\n';
        const french = await fixture.upload(
            frenchText,
            'cohere-fr.txt',
            collectionId
        );
        const english = await fixture.upload(
            englishText,
            'cohere-en.txt',
            collectionId
        );
        const searchInput = {
            collectionId,
            query: 'context renard',
            strategy: 'HYBRID' as const,
            topK: 10,
            filters: {},
        };

        await t.test(
            'Cohere discovers a bounded hosted catalog and probes exact native roles and supported dimensions through the saved organization binding',
            async () => {
                const listed = await f.owner.rag.indexing.models({
                    collectionId,
                });
                assert(
                    listed.items.some((item) => item.model === 'embed-v4.0')
                );
                assert(
                    !listed.items.some((item) => item.model === 'chat-model')
                );
                assert(
                    !listed.items.some(
                        (item) =>
                            item.model === 'unapproved-new-embedding-model'
                    )
                );
                assert.equal(listed.discoverySource, 'HOSTED_CATALOG');
                for (const dimensions of [256, 512, 1024, 1536]) {
                    if (dimensions !== 256)
                        revision = (await draft(collectionId, { dimensions }))
                            .configurationRevision;
                    const before = cohere.embeddings().length;
                    const probed = await f.owner.rag.indexing.probe({
                        collectionId,
                        expectedRevision: revision,
                    });
                    assert.equal(probed.provider, 'COHERE');
                    assert.equal(probed.identityKind, 'CAPABILITY_PROFILE');
                    assert.equal(probed.model, 'embed-v4.0');
                    assert.equal(probed.dimensions, dimensions);
                    assert.deepEqual(
                        probed.supportedDimensions,
                        [256, 512, 1024, 1536]
                    );
                    const calls = cohere.embeddings().slice(before);
                    assert.deepEqual(
                        new Set(calls.map((call) => call.body.input_type)),
                        new Set(['search_document', 'search_query'])
                    );
                    for (const call of calls) {
                        assert.equal(
                            call.authorization,
                            `Bearer ${COHERE_ORGANIZATION_KEY}`
                        );
                        assert.equal(call.body.output_dimension, dimensions);
                        assert.equal(call.body.truncate, 'NONE');
                        assert.deepEqual(call.body.embedding_types, ['float']);
                        assert(
                            call.body.texts?.every((text) =>
                                text.startsWith(
                                    `${nativeProfile.preparation}\n`
                                )
                            )
                        );
                        assert(
                            call.body.texts?.every(
                                (text) =>
                                    !text.includes(
                                        'task: search result | query:'
                                    )
                            )
                        );
                    }
                }
                revision = (await draft(collectionId, { dimensions: 256 }))
                    .configurationRevision;
                await assert.rejects(
                    f.owner.rag.indexing.models({
                        collectionId,
                        expectedRevision: 1,
                    }),
                    failure('MODEL_CHANGED')
                );
                const entered = Promise.withResolvers<void>();
                const released = Promise.withResolvers<void>();
                cohere.state.beforeModels = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const pending = f.owner.rag.indexing
                    .models({ collectionId, expectedRevision: revision })
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                try {
                    await waitForCohereRequest(entered.promise);
                    delete cohere.state.beforeModels;
                    revision = (
                        await draft(collectionId, {
                            preparation: 'Concurrent draft.',
                        })
                    ).configurationRevision;
                } finally {
                    delete cohere.state.beforeModels;
                    released.resolve();
                }
                failure('MODEL_CHANGED')(await pending);
                revision = (
                    await draft(collectionId, {
                        preparation: nativeProfile.preparation,
                    })
                ).configurationRevision;
                const nativeModels = cohere.state.calls.filter(
                    (call) => call.path === '/v1/models'
                );
                assert(nativeModels.length > 0);
                assert(
                    nativeModels.every(
                        (call) =>
                            call.authorization ===
                            `Bearer ${COHERE_ORGANIZATION_KEY}`
                    )
                );
            }
        );

        await t.test(
            'Cohere rejects unsupported dimensions, presets and malformed vectors before accepting an index generation',
            async () => {
                const invalid = await f.owner.rag.collections.create({
                    name: `Unsupported Cohere dimensions ${randomUUID()}`,
                    profile: { ...nativeProfile, dimensions: 255 },
                });
                const before = cohere.embeddings().length;
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: invalid.id,
                        expectedRevision: 1,
                    }),
                    failure('DIMENSIONS_UNSUPPORTED')
                );
                await assert.rejects(
                    f.owner.rag.indexing.start({
                        collectionId: invalid.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    }),
                    failure('DIMENSIONS_UNSUPPORTED')
                );
                assert.equal(cohere.embeddings().length, before);
                assert.equal(
                    await prisma.indexGeneration.count({
                        where: { collectionId: invalid.id },
                    }),
                    0
                );
                const preset = await draft(invalid.id, {
                    dimensions: 256,
                    embeddingPreset: 'EMBEDDING_GEMMA',
                });
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: invalid.id,
                        expectedRevision: preset.configurationRevision,
                    }),
                    failure('PROFILE_UNSUPPORTED')
                );
                cohere.state.invalidDimensions = true;
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.probe({
                            collectionId,
                            expectedRevision: revision,
                        }),
                        failure('INVALID_PROVIDER_RESPONSE')
                    );
                } finally {
                    cohere.state.invalidDimensions = false;
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
            'Cohere indexes immutable FR/EN documents and searches with native query vectors and exact source receipts',
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
                assert.equal(snapshot.provider, 'COHERE');
                assert.equal(snapshot.schemaVersion, 2);
                assert.equal(snapshot.identityKind, 'CAPABILITY_PROFILE');
                assert.equal(snapshot.digest, generation.modelIdentity);
                const response = await f.owner.rag.indexing.search(searchInput);
                assert.equal(response.generationId, activeId);
                assert(
                    response.results.some(
                        (result) => result.documentId === french.id
                    )
                );
                assert(
                    response.results.some(
                        (result) => result.documentId === english.id
                    )
                );
                sourceReceipt = response.results.find(
                    (result) => result.documentId === french.id
                )!.source.receipt;
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text,
                    frenchText
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
                const contentCalls = cohere
                    .embeddings()
                    .filter((call) =>
                        call.body.texts?.some(
                            (text) =>
                                text.includes('Contexte français') ||
                                text.includes('English context')
                        )
                    );
                assert(contentCalls.length > 0);
                assert(
                    contentCalls.every(
                        (call) => call.body.input_type === 'search_document'
                    )
                );
                assert(
                    cohere
                        .embeddings()
                        .some(
                            (call) =>
                                call.body.input_type === 'search_query' &&
                                call.body.texts?.some((text) =>
                                    text.includes(searchInput.query)
                                )
                        )
                );
                const rest = await app.request(
                    `/api/v1/admin/rag/collections/${collectionId}/search`,
                    {
                        method: 'POST',
                        headers: {
                            ...f.owner.headers(),
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify(searchInput),
                    }
                );
                assert.equal(rest.status, 200);
                const result = await rest.json();
                assert.equal(result.generationId, response.generationId);
                assert.deepEqual(
                    result.results.map((item: { id: string }) => item.id),
                    response.results.map((item) => item.id)
                );
            }
        );

        await t.test(
            'Cohere preserves saved organization and platform bindings through secret rotation and invalid organization configuration never falls back',
            async () => {
                await f.owner.rag.indexing.probe({
                    collectionId: platform.id,
                    expectedRevision: 1,
                });
                assert(cohere.platformCalls() > 0);
                const beforePlatform = cohere.platformCalls();
                const rotated = await f.owner.rag.credentials.update({
                    id: credential.id,
                    expectedRevision: 1,
                    name: credential.name,
                    data: {
                        provider: 'COHERE',
                        endpoint: cohere.endpoint,
                        apiKey: COHERE_ROTATED_KEY,
                    },
                });
                const beforeRotation = cohere.embeddings().length;
                await f.owner.rag.indexing.search(searchInput);
                assert(
                    cohere
                        .embeddings()
                        .slice(beforeRotation)
                        .every(
                            (call) =>
                                call.authorization ===
                                `Bearer ${COHERE_ROTATED_KEY}`
                        )
                );
                const invalid = await f.owner.rag.credentials.create({
                    name: 'Invalid active Cohere key',
                    data: {
                        provider: 'COHERE',
                        endpoint: cohere.endpoint,
                        apiKey: 'invalid-synthetic-key',
                    },
                });
                await f.owner.rag.indexing.search(searchInput);
                const broken = await f.owner.rag.collections.create({
                    name: `Broken Cohere key ${randomUUID()}`,
                    profile: nativeProfile,
                });
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
                assert.equal(cohere.platformCalls(), beforePlatform);
                assert.equal(
                    await prisma.indexGeneration.count({
                        where: { collectionId: broken.id },
                    }),
                    0
                );
                await f.owner.rag.credentials.activate({ id: credential.id });
                await assert.rejects(
                    f.owner.rag.credentials.update({
                        id: credential.id,
                        expectedRevision: rotated.revision,
                        name: credential.name,
                        data: {
                            provider: 'COHERE',
                            endpoint: `${cohere.endpoint}/changed`,
                        },
                    }),
                    { code: 'CONFLICT' }
                );
                await f.owner.rag.credentials
                    .delete({ id: invalid.id, expectedRevision: 1 })
                    .then(
                        () =>
                            assert.fail(
                                'A retained credential must not be deleted.'
                            ),
                        (error: unknown) =>
                            assert(
                                error &&
                                    typeof error === 'object' &&
                                    'code' in error &&
                                    error.code === 'CONFLICT'
                            )
                    );
                const denied = await f.owner.rag.credentials.create({
                    name: 'Unapproved Cohere destination',
                    data: {
                        provider: 'COHERE',
                        endpoint: `${cohere.endpoint}/unapproved`,
                        apiKey: COHERE_ORGANIZATION_KEY,
                    },
                });
                const deniedCollection = await f.owner.rag.collections.create({
                    name: `Unapproved Cohere ${randomUUID()}`,
                    profile: nativeProfile,
                });
                const callCount = cohere.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: deniedCollection.id,
                        expectedRevision: 1,
                    }),
                    failure('CREDENTIALS_INVALID')
                );
                assert.equal(cohere.state.calls.length, callCount);
                assert.equal(
                    deniedCollection.configuration.credentialId,
                    denied.id
                );
                await f.owner.rag.credentials.activate({ id: credential.id });
            }
        );

        await t.test(
            'Cohere native execution keeps current collection grants, organization isolation and session-only model administration',
            async () => {
                const before = cohere.state.calls.length;
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
                assert.equal(cohere.state.calls.length, before);
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Cohere source reader',
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
                assert.equal(
                    (await api.search(searchInput)).generationId,
                    activeId
                );
                await assert.rejects(
                    api.probe({ collectionId, expectedRevision: revision }),
                    { code: 'FORBIDDEN' }
                );
                const entered = Promise.withResolvers<void>();
                const released = Promise.withResolvers<void>();
                cohere.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = api.search(searchInput).then(
                    () => null,
                    (error: unknown) => error
                );
                try {
                    await waitForCohereRequest(entered.promise);
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
                    delete cohere.state.beforeEmbedding;
                    released.resolve();
                }
                const denied = await inFlight;
                assert(
                    denied && typeof denied === 'object' && 'code' in denied
                );
                assert(
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
            'an Ollama generation keeps serving across Cohere rebuild failure and switches only after an explicit successful retry',
            async () => {
                const legacy = await fixture.collection(
                    `Ollama to Cohere ${randomUUID()}`
                );
                const text =
                    'Cross-provider context: foxes live in protected forests.\n';
                await fixture.upload(text, 'cross-provider.txt', legacy.id);
                const first = await f.owner.rag.indexing.start({
                    collectionId: legacy.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await fixture.scan(6);
                const legacyQuery = {
                    ...searchInput,
                    collectionId: legacy.id,
                    query: 'context foxes',
                };
                const entered = Promise.withResolvers<void>();
                const released = Promise.withResolvers<void>();
                fixture.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = f.owner.rag.indexing.search(legacyQuery).then(
                    (result) => ({ result }),
                    (error: unknown) => ({ error })
                );
                try {
                    await waitForCohereRequest(entered.promise);
                    delete fixture.state.beforeEmbedding;
                    const changed = await draft(legacy.id, nativeProfile);
                    const rebuilding = await f.owner.rag.indexing.rebuild({
                        collectionId: legacy.id,
                        expectedRevision: changed.configurationRevision,
                        expectedActiveGenerationId: first.generationId,
                        requestId: randomUUID(),
                    });
                    cohere.state.rejectEmbeddings = true;
                    await fixture.scan(3);
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: legacy.id,
                            })
                        ).active?.id,
                        first.generationId
                    );
                    assert.equal(
                        (await f.owner.rag.indexing.search(legacyQuery))
                            .generationId,
                        first.generationId
                    );
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId: rebuilding.generationId,
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
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: rebuilding.generationId },
                            })
                        ).status,
                        'BUILDING'
                    );
                    cohere.state.rejectEmbeddings = false;
                    await f.owner.rag.indexing.retry({
                        collectionId: legacy.id,
                        taskId: task.id,
                    });
                    await fixture.scan(6);
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: legacy.id,
                            })
                        ).active?.id,
                        rebuilding.generationId
                    );
                    const current =
                        await f.owner.rag.indexing.search(legacyQuery);
                    assert.equal(current.generationId, rebuilding.generationId);
                    assert.equal(
                        await (
                            await f.owner.rag.indexing.sourceOriginal({
                                collectionId: legacy.id,
                                receipt: current.results[0]!.source.receipt,
                            })
                        ).text(),
                        text
                    );
                    const original =
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: first.generationId },
                        });
                    assert.equal(original.status, 'RETIRED');
                    assert(
                        original.capabilitySnapshot &&
                            typeof original.capabilitySnapshot === 'object' &&
                            !Array.isArray(original.capabilitySnapshot)
                    );
                    assert.equal(original.capabilitySnapshot.schemaVersion, 1);
                    assert.equal(
                        original.capabilitySnapshot.provider,
                        'OLLAMA'
                    );
                } finally {
                    delete fixture.state.beforeEmbedding;
                    cohere.state.rejectEmbeddings = false;
                    released.resolve();
                }
                const outcome = await inFlight;
                if ('error' in outcome) throw outcome.error;
                const captured = outcome.result;
                assert.equal(captured.generationId, first.generationId);
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: legacy.id,
                            receipt: captured.results[0]!.source.receipt,
                        })
                    ).text(),
                    text
                );
            }
        );
    } finally {
        await cohere.close();
        if (priorEnvironment.endpoint === undefined)
            delete process.env.VECTORIX_DEFAULT_COHERE_ENDPOINT;
        else
            process.env.VECTORIX_DEFAULT_COHERE_ENDPOINT =
                priorEnvironment.endpoint;
        if (priorEnvironment.key === undefined)
            delete process.env.VECTORIX_DEFAULT_COHERE_API_KEY;
        else process.env.VECTORIX_DEFAULT_COHERE_API_KEY = priorEnvironment.key;
        await fixture.close();
        f.org = previousOrganization.id;
        f.ownerMember = previousOrganization.owner;
        f.managerMember = previousOrganization.manager;
        await f.owner.post('organization/set-active', {
            organizationId: f.org,
        });
        await f.manager.post('organization/set-active', {
            organizationId: f.org,
        });
    }
}
