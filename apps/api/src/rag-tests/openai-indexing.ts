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
    createOpenAIHttpFixture,
    waitForOpenAIRequest,
    OPENAI_ORGANIZATION_KEY,
    OPENAI_PLATFORM_KEY,
    OPENAI_ROTATED_KEY,
    OPENAI_PROXY_PREFIX,
} from './openai-fixtures';
import { app } from '../app';

/** Only public diagnostics may survive a failed native call; never provider bodies or recoverable secrets. */
function failure(code: string) {
    return (error: unknown) => {
        assert(error && typeof error === 'object' && 'data' in error);
        assert.deepEqual(error.data, { errorCode: code });
        const encoded = JSON.stringify(error);
        for (const secret of [
            OPENAI_ORGANIZATION_KEY,
            OPENAI_PLATFORM_KEY,
            OPENAI_ROTATED_KEY,
            'private-openai-provider-body',
        ])
            assert(!encoded.includes(secret));
        return true;
    };
}

/** Controlled native OpenAI + actual catalog/vector/object storage; this never claims hosted model connectivity or relevance. */
export async function openaiIndexingTests(t: TestContext) {
    const previous = {
        organization: f.org,
        owner: f.ownerMember,
        manager: f.managerMember,
    };
    const organization = await f.owner.post('organization/create', {
        name: `OpenAI isolation ${randomUUID()}`,
        slug: `openai-${randomUUID()}`,
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
    const openai = await createOpenAIHttpFixture();
    const cohere = await createCohereHttpFixture();
    const environment = {
        endpoint: process.env.VECTORIX_DEFAULT_OPENAI_ENDPOINT,
        key: process.env.VECTORIX_DEFAULT_OPENAI_API_KEY,
    };
    process.env.VECTORIX_DEFAULT_OPENAI_ENDPOINT = openai.endpoint;
    process.env.VECTORIX_DEFAULT_OPENAI_API_KEY = OPENAI_PLATFORM_KEY;
    process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = `${fixture.endpoint},${cohere.endpoint},${openai.endpoint}`;
    const nativeProfile = {
        provider: 'OPENAI' as const,
        model: 'text-embedding-3-small',
        dimensions: 257,
        embeddingPreset: 'GENERIC' as const,
        preparation: 'Literal OpenAI preparation.',
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
            name: 'OpenAI platform binding',
            profile: nativeProfile,
            grantCreatorRead: true,
        });
        assert.equal(platform.configuration.credentialId, null);
        const credential = await f.owner.rag.credentials.create({
            name: 'OpenAI organization binding',
            data: {
                provider: 'OPENAI',
                endpoint: openai.endpoint,
                apiKey: OPENAI_ORGANIZATION_KEY,
            },
        });
        const collection = await f.owner.rag.collections.create({
            name: 'Native OpenAI passages',
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
            '# Needle\nneedle-openai désigne le passage exact recherché.\n\n# Middle\nOrdinary forests and foxes surround this middle reference.\n\n# Last\nOrdinary solar panels provide the final reference.\n';
        const french = await fixture.upload(
            frenchText,
            'openai-fr.md',
            collectionId
        );
        const english = await fixture.upload(
            'English context: solar energy powers a sustainable future.\n',
            'openai-en.txt',
            collectionId
        );
        const query = {
            collectionId,
            query: 'needle-openai',
            strategy: 'VECTOR' as const,
            topK: 1,
            filters: {},
        };

        await t.test(
            'OpenAI native catalog retains the approved proxy prefix, intersects reviewed IDs and adds optional range metadata compatibly',
            async () => {
                const before = openai.state.calls.length;
                const listed = await f.owner.rag.indexing.models({
                    collectionId,
                    expectedRevision: revision,
                });
                assert.deepEqual(
                    new Set(listed.items.map((item) => item.model)),
                    new Set([
                        'text-embedding-3-small',
                        'text-embedding-3-large',
                    ])
                );
                assert.equal(listed.discoverySource, 'HOSTED_CATALOG');
                assert.equal(listed.reviewedCatalog, undefined);
                const calls = openai.state.calls.slice(before);
                assert.equal(calls.length, 1);
                assert.equal(calls[0]!.path, `${OPENAI_PROXY_PREFIX}/models`);
                assert.equal(calls[0]!.method, 'GET');
                assert.equal(
                    calls[0]!.authorization,
                    `Bearer ${OPENAI_ORGANIZATION_KEY}`
                );
                for (const item of listed.items) {
                    assert.equal(item.identityKind, 'CAPABILITY_PROFILE');
                    assert.deepEqual(item.dimensionCapability, {
                        kind: 'RANGE',
                        minimum: 1,
                        maximum:
                            item.model === 'text-embedding-3-small'
                                ? 1536
                                : 3072,
                        step: 1,
                    });
                }
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
                assert.equal(oldDto.dimensionCapability, undefined);
            }
        );

        await t.test(
            'OpenAI probes both logical input paths with float native payloads, shortened size257 and default large3072 without invented roles or truncation',
            async () => {
                for (const [model, dimensions] of [
                    ['text-embedding-3-small', 1],
                    ['text-embedding-3-small', 257],
                    ['text-embedding-3-small', 1536],
                    ['text-embedding-3-large', 3072],
                ] as const) {
                    revision = (
                        await draft(collectionId, { model, dimensions })
                    ).configurationRevision;
                    const before = openai.state.calls.length;
                    const probed = await f.owner.rag.indexing.probe({
                        collectionId,
                        expectedRevision: revision,
                    });
                    assert.equal(probed.provider, 'OPENAI');
                    assert.equal(probed.model, model);
                    assert.equal(probed.identityKind, 'CAPABILITY_PROFILE');
                    assert.equal(probed.discoverySource, 'HOSTED_CATALOG');
                    assert.equal(probed.dimensions, dimensions);
                    assert.deepEqual(probed.supportedDimensions, [dimensions]);
                    assert.deepEqual(probed.dimensionCapability, {
                        kind: 'RANGE',
                        minimum: 1,
                        maximum:
                            model === 'text-embedding-3-small' ? 1536 : 3072,
                        step: 1,
                    });
                    const calls = openai.state.calls.slice(before);
                    assert.equal(calls.length, 2);
                    for (const call of calls) {
                        assert.equal(
                            call.path,
                            `${OPENAI_PROXY_PREFIX}/embeddings`
                        );
                        assert.equal(call.method, 'POST');
                        assert.equal(
                            call.authorization,
                            `Bearer ${OPENAI_ORGANIZATION_KEY}`
                        );
                        assert.deepEqual(Object.keys(call.body).toSorted(), [
                            'dimensions',
                            'encoding_format',
                            'input',
                            'model',
                        ]);
                        assert.equal(call.body.dimensions, dimensions);
                        assert.equal(call.body.encoding_format, 'float');
                        assert(
                            call.body.input?.every((value) =>
                                value.startsWith(
                                    `${nativeProfile.preparation}\n`
                                )
                            )
                        );
                    }
                }
                revision = (
                    await draft(collectionId, {
                        model: 'text-embedding-3-small',
                        dimensions: 257,
                    })
                ).configurationRevision;
                for (const operation of ['models', 'probe'] as const)
                    await assert.rejects(
                        f.owner.rag.indexing[operation]({
                            collectionId,
                            expectedRevision: 1,
                        }),
                        failure('MODEL_CHANGED')
                    );
                const invalid = await f.owner.rag.collections.create({
                    name: 'Invalid OpenAI dimensions',
                    profile: { ...nativeProfile, dimensions: 1537 },
                });
                const beforeInvalid = openai.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.start({
                        collectionId: invalid.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    }),
                    failure('DIMENSIONS_UNSUPPORTED')
                );
                assert.equal(openai.state.calls.length, beforeInvalid);
                openai.state.invalidIndex = true;
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
                    openai.state.invalidIndex = false;
                }
                openai.state.invalidDimensions = true;
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.probe({
                            collectionId,
                            expectedRevision: revision,
                        }),
                        failure('INVALID_PROVIDER_RESPONSE')
                    );
                } finally {
                    openai.state.invalidDimensions = false;
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
            'OpenAI discovery and probes reject a saved draft revision changed during controlled native I/O',
            async () => {
                const race = await f.owner.rag.collections.create({
                    name: 'OpenAI revision fence',
                    profile: nativeProfile,
                });
                let raceRevision = race.configurationRevision;
                for (const operation of ['models', 'probe'] as const) {
                    const entered = Promise.withResolvers<void>();
                    const released = Promise.withResolvers<void>();
                    const wait = async () => {
                        entered.resolve();
                        await released.promise;
                    };
                    if (operation === 'models')
                        openai.state.beforeModels = wait;
                    else openai.state.beforeEmbedding = wait;
                    const pending = f.owner.rag.indexing[operation]({
                        collectionId: race.id,
                        expectedRevision: raceRevision,
                    }).then(
                        () => null,
                        (error: unknown) => error
                    );
                    try {
                        await waitForOpenAIRequest(entered.promise);
                        raceRevision = (
                            await draft(race.id, {
                                preparation: `Changed while ${operation} was in flight.`,
                            })
                        ).configurationRevision;
                    } finally {
                        delete openai.state.beforeModels;
                        delete openai.state.beforeEmbedding;
                        released.resolve();
                    }
                    assert(failure('MODEL_CHANGED')(await pending));
                }
            }
        );

        await t.test(
            'OpenAI rejects duplicate bulk indices before publication, retries durably and retains exact reordered vector-to-passage association and FR/EN sources',
            async () => {
                activeId = (
                    await f.owner.rag.indexing.start({
                        collectionId,
                        expectedRevision: revision,
                        requestId: randomUUID(),
                    })
                ).generationId;
                openai.state.duplicateIndex = true;
                try {
                    await fixture.scan(3);
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId: activeId,
                            indexedDocument: { is: { documentId: french.id } },
                            kind: 'INDEX_DOCUMENT',
                            status: 'PENDING',
                        },
                    });
                    assert.equal(
                        (await f.owner.rag.indexing.status({ collectionId }))
                            .active,
                        null
                    );
                    assert.equal(
                        await prisma.indexedDocument.count({
                            where: {
                                generationId: activeId,
                                documentId: french.id,
                                status: 'PUBLISHED',
                            },
                        }),
                        0
                    );
                    await prisma.indexTask.update({
                        where: { id: task.id },
                        data: { attempts: 4, availableAt: new Date(0) },
                    });
                    await fixture.scan(1);
                    const failed = await prisma.indexTask.findUniqueOrThrow({
                        where: { id: task.id },
                    });
                    assert.equal(failed.status, 'FAILED');
                    assert.equal(failed.errorCode, 'INVALID_PROVIDER_RESPONSE');
                    openai.state.duplicateIndex = false;
                    await f.owner.rag.indexing.retry({
                        collectionId,
                        taskId: task.id,
                    });
                    await fixture.scan(8);
                } finally {
                    openai.state.duplicateIndex = false;
                }
                const status = await f.owner.rag.indexing.status({
                    collectionId,
                });
                assert.equal(status.active?.id, activeId);
                assert.equal(status.unsupportedReason, null);
                assert.equal(status.usage.reservedChunks, 0);
                assert(
                    openai.state.calls.some(
                        (call) => (call.body.input?.length ?? 0) > 1
                    )
                );
                const result = await f.owner.rag.indexing.search(query);
                assert.equal(result.generationId, activeId);
                assert.equal(result.results.length, 1);
                assert.equal(result.results[0]!.documentId, french.id);
                assert(result.results[0]!.text.includes('needle-openai'));
                assert.equal(result.results[0]!.scores.vectorDistance, 0);
                sourceReceipt = result.results[0]!.source.receipt;
                assert(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text.includes('needle-openai')
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
                assert.equal(snapshot.schemaVersion, 4);
                assert.equal(snapshot.provider, 'OPENAI');
                assert.equal(snapshot.identityKind, 'CAPABILITY_PROFILE');
                assert.equal(snapshot.digest, generation.modelIdentity);
                assert.equal(snapshot.dimensions, 257);
                assert.deepEqual(snapshot.supportedDimensions, [257]);
                assert.deepEqual(snapshot.dimensionCapability, {
                    kind: 'RANGE',
                    minimum: 1,
                    maximum: 1536,
                    step: 1,
                });
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
                assert.equal(rest.headers.get('Vectorix-API-Revision'), '14');
                assert.equal(
                    (await rest.json()).results[0].id,
                    result.results[0]!.id
                );
            }
        );

        await t.test(
            'OpenAI saved organization bindings survive key rotation, invalid configured credentials never fall back and unapproved destinations perform no I/O',
            async () => {
                await f.owner.rag.indexing.probe({
                    collectionId: platform.id,
                    expectedRevision: 1,
                });
                const platformCalls = openai.platformCalls();
                assert(platformCalls > 0);
                await f.owner.rag.credentials.update({
                    id: credential.id,
                    expectedRevision: 1,
                    name: credential.name,
                    data: {
                        provider: 'OPENAI',
                        endpoint: openai.endpoint,
                        apiKey: OPENAI_ROTATED_KEY,
                    },
                });
                const rotatedAt = openai.state.calls.length;
                await f.owner.rag.indexing.search(query);
                assert(
                    openai.state.calls
                        .slice(rotatedAt)
                        .every(
                            (call) =>
                                call.authorization ===
                                `Bearer ${OPENAI_ROTATED_KEY}`
                        )
                );
                await f.owner.rag.credentials.create({
                    name: 'Invalid OpenAI key',
                    data: {
                        provider: 'OPENAI',
                        endpoint: openai.endpoint,
                        apiKey: 'invalid-synthetic-key',
                    },
                });
                const broken = await f.owner.rag.collections.create({
                    name: 'Broken OpenAI key',
                    profile: nativeProfile,
                });
                await assert.rejects(
                    f.owner.rag.indexing.models({
                        collectionId: broken.id,
                    }),
                    failure('PROVIDER_REJECTED')
                );
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
                assert.equal(openai.platformCalls(), platformCalls);
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
                    name: 'Unapproved OpenAI destination',
                    data: {
                        provider: 'OPENAI',
                        endpoint: `${openai.endpoint}/unapproved`,
                        apiKey: OPENAI_ORGANIZATION_KEY,
                    },
                });
                const denied = await f.owner.rag.collections.create({
                    name: 'Unapproved OpenAI endpoint',
                    profile: nativeProfile,
                });
                assert.equal(
                    denied.configuration.credentialId,
                    deniedCredential.id
                );
                const requestCount = openai.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: denied.id,
                        expectedRevision: 1,
                    }),
                    failure('CREDENTIALS_INVALID')
                );
                assert.equal(openai.state.calls.length, requestCount);
                await f.owner.rag.credentials.activate({ id: credential.id });
            }
        );

        await t.test(
            'OpenAI retrieval uses current collection grants and key scopes after native query I/O',
            async () => {
                const before = openai.state.calls.length;
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
                assert.equal(openai.state.calls.length, before);
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'OpenAI search only',
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
                openai.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = api.search(query).then(
                    () => null,
                    (error: unknown) => error
                );
                try {
                    await waitForOpenAIRequest(entered.promise);
                    await f.owner.client.admin.organization.apiKeys.updatePermissions(
                        {
                            keyId: key.id,
                            permissions: {
                                ragCollection: ['read'],
                                ragLibrary: ['read'],
                            },
                            collectionScopes: [],
                        }
                    );
                } finally {
                    delete openai.state.beforeEmbedding;
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
                await f.owner.client.admin.organization.apiKeys.updatePermissions(
                    {
                        keyId: key.id,
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
                    }
                );
            }
        );

        await t.test(
            'a captured Cohere query and exact source survive a failed OpenAI successor and explicit retry to schema-four activation',
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
                    name: 'Cohere to OpenAI',
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
                    'openai-rebuild-source.txt',
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
                    await waitForOpenAIRequest(entered.promise);
                    delete cohere.state.beforeEmbedding;
                    const changed = await draft(legacy.id, nativeProfile);
                    const candidate = await f.owner.rag.indexing.rebuild({
                        collectionId: legacy.id,
                        expectedRevision: changed.configurationRevision,
                        expectedActiveGenerationId: first.generationId,
                        requestId: randomUUID(),
                    });
                    openai.state.rejectEmbeddings = true;
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
                    openai.state.rejectEmbeddings = false;
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
                    const successor =
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: candidate.generationId },
                        });
                    assert(
                        successor.capabilitySnapshot &&
                            typeof successor.capabilitySnapshot === 'object' &&
                            !Array.isArray(successor.capabilitySnapshot)
                    );
                    assert.equal(successor.capabilitySnapshot.schemaVersion, 4);
                    assert.equal(
                        successor.capabilitySnapshot.provider,
                        'OPENAI'
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
                    openai.state.rejectEmbeddings = false;
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
        await openai.close();
        await cohere.close();
        if (environment.endpoint === undefined)
            delete process.env.VECTORIX_DEFAULT_OPENAI_ENDPOINT;
        else
            process.env.VECTORIX_DEFAULT_OPENAI_ENDPOINT = environment.endpoint;
        if (environment.key === undefined)
            delete process.env.VECTORIX_DEFAULT_OPENAI_API_KEY;
        else process.env.VECTORIX_DEFAULT_OPENAI_API_KEY = environment.key;
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
