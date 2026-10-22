import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { verifiedEmbedding } from '@repo/api-contracts/v1/rag/indexing-types';
import { fixture as f, rpc } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';
import {
    createOpenAIHttpFixture,
    OPENAI_ORGANIZATION_KEY,
} from './openai-fixtures';
import {
    createMistralHttpFixture,
    waitForMistralRequest,
    MISTRAL_ORGANIZATION_KEY,
    MISTRAL_PLATFORM_KEY,
    MISTRAL_ROTATED_KEY,
    MISTRAL_PROXY_PREFIX,
} from './mistral-fixtures';
import { app } from '../app';

/** Only public diagnostics may survive a failed native call; never provider bodies or recoverable secrets. */
function failure(code: string) {
    return (error: unknown) => {
        assert(error && typeof error === 'object' && 'data' in error);
        assert.deepEqual(error.data, { errorCode: code });
        const encoded = JSON.stringify(error);
        for (const secret of [
            MISTRAL_ORGANIZATION_KEY,
            MISTRAL_PLATFORM_KEY,
            MISTRAL_ROTATED_KEY,
            'private-mistral-provider-body',
        ])
            assert(!encoded.includes(secret));
        return true;
    };
}

/** Controlled native Mistral + actual catalog/vector/object storage; this never claims hosted model connectivity or relevance. */
export async function mistralIndexingTests(t: TestContext) {
    const previous = {
        organization: f.org,
        owner: f.ownerMember,
        manager: f.managerMember,
    };
    const organization = await f.owner.post('organization/create', {
        name: `Mistral isolation ${randomUUID()}`,
        slug: `mistral-${randomUUID()}`,
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
    const mistral = await createMistralHttpFixture();
    const legacyOpenAI = await createOpenAIHttpFixture();
    const environment = {
        endpoint: process.env.VECTORIX_DEFAULT_MISTRAL_ENDPOINT,
        key: process.env.VECTORIX_DEFAULT_MISTRAL_API_KEY,
    };
    process.env.VECTORIX_DEFAULT_MISTRAL_ENDPOINT = mistral.endpoint;
    process.env.VECTORIX_DEFAULT_MISTRAL_API_KEY = MISTRAL_PLATFORM_KEY;
    process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS = `${fixture.endpoint},${legacyOpenAI.endpoint},${mistral.endpoint}`;
    const nativeProfile = {
        provider: 'MISTRAL' as const,
        model: 'mistral-embed',
        dimensions: 1024,
        embeddingPreset: 'GENERIC' as const,
        preparation: 'Literal Mistral preparation.',
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
            name: 'Mistral platform binding',
            profile: nativeProfile,
            grantCreatorRead: true,
        });
        assert.equal(platform.configuration.credentialId, null);
        const credential = await f.owner.rag.credentials.create({
            name: 'Mistral organization binding',
            data: {
                provider: 'MISTRAL',
                endpoint: mistral.endpoint,
                apiKey: MISTRAL_ORGANIZATION_KEY,
            },
        });
        const collection = await f.owner.rag.collections.create({
            name: 'Native Mistral passages',
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
            '# Needle\nneedle-mistral désigne le passage exact recherché.\n\n# Middle\nOrdinary forests and foxes surround this middle reference.\n\n# Last\nOrdinary solar panels provide the final reference.\n';
        const french = await fixture.upload(
            frenchText,
            'mistral-fr.md',
            collectionId
        );
        const english = await fixture.upload(
            'English context: solar energy powers a sustainable future.\n',
            'mistral-en.txt',
            collectionId
        );
        const query = {
            collectionId,
            query: 'needle-mistral',
            strategy: 'VECTOR' as const,
            topK: 1,
            filters: {},
        };

        await t.test(
            'Mistral native catalog intersects reviewed IDs and aliases without an invented embeddings flag and preserves legacy OpenAI range DTOs',
            async () => {
                const before = mistral.state.calls.length;
                const listed = await f.owner.rag.indexing.models({
                    collectionId,
                    expectedRevision: revision,
                });
                assert.deepEqual(
                    new Set(listed.items.map((item) => item.model)),
                    new Set(['mistral-embed', 'mistral-embed-2312'])
                );
                assert.equal(listed.discoverySource, 'HOSTED_CATALOG');
                assert.equal(listed.reviewedCatalog, undefined);
                const calls = mistral.state.calls.slice(before);
                assert.equal(calls.length, 1);
                assert.equal(calls[0]!.path, `${MISTRAL_PROXY_PREFIX}/models`);
                assert.equal(calls[0]!.method, 'GET');
                assert.equal(
                    calls[0]!.authorization,
                    `Bearer ${MISTRAL_ORGANIZATION_KEY}`
                );
                for (const item of listed.items) {
                    assert.equal(item.identityKind, 'CAPABILITY_PROFILE');
                    assert.equal(item.defaultDimensions, 1024);
                    assert.deepEqual(item.supportedDimensions, [1024]);
                    assert.equal(item.dimensionCapability, undefined);
                    assert.equal(item.contextTokens, 8000);
                }
                mistral.state.unreviewedCatalog = true;
                try {
                    const unreviewed = await f.owner.rag.indexing.models({
                        collectionId,
                        expectedRevision: revision,
                    });
                    assert.equal(unreviewed.items.length, 0);
                    assert.equal(unreviewed.discoverySource, 'HOSTED_CATALOG');
                } finally {
                    mistral.state.unreviewedCatalog = false;
                }
                const oldOpenAI = verifiedEmbedding.parse({
                    provider: 'OPENAI',
                    model: 'text-embedding-3-small',
                    digest: 'a'.repeat(64),
                    family: 'openai-embedding-3',
                    contextTokens: 8192,
                    dimensions: 257,
                    defaultDimensions: 1536,
                    supportedDimensions: [257],
                    preset: 'GENERIC',
                    dimensionCapability: {
                        kind: 'RANGE',
                        minimum: 1,
                        maximum: 1536,
                        step: 1,
                    },
                });
                assert.equal(oldOpenAI.responseModel, undefined);
                assert.equal(oldOpenAI.dimensionCapability?.maximum, 1536);
                assert.deepEqual(oldOpenAI.supportedDimensions, [257]);
                const oldOllama = verifiedEmbedding.parse({
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
                assert.equal(oldOllama.responseModel, undefined);
            }
        );

        await t.test(
            'Mistral fixed1024 probes bind the actually observed reviewed model on both paths and reject invalid dimensions, presets, responses and probe-time drift',
            async () => {
                for (const [model, responseModel] of [
                    ['mistral-embed', 'mistral-embed-2312'],
                    ['mistral-embed-2312', 'mistral-embed'],
                ] as const) {
                    revision = (await draft(collectionId, { model }))
                        .configurationRevision;
                    mistral.state.responseModel = responseModel;
                    const before = mistral.state.calls.length;
                    const probed = await f.owner.rag.indexing.probe({
                        collectionId,
                        expectedRevision: revision,
                    });
                    assert.equal(probed.provider, 'MISTRAL');
                    assert.equal(probed.model, model);
                    assert.equal(probed.responseModel, responseModel);
                    assert.equal(probed.identityKind, 'CAPABILITY_PROFILE');
                    assert.equal(probed.discoverySource, 'HOSTED_CATALOG');
                    assert.equal(probed.dimensions, 1024);
                    assert.equal(probed.contextTokens, 8000);
                    assert.deepEqual(probed.supportedDimensions, [1024]);
                    assert.equal(probed.dimensionCapability, undefined);
                    const calls = mistral.state.calls.slice(before);
                    assert.equal(calls.length, 2);
                    for (const call of calls) {
                        assert.equal(
                            call.path,
                            `${MISTRAL_PROXY_PREFIX}/embeddings`
                        );
                        assert.equal(call.method, 'POST');
                        assert.equal(
                            call.authorization,
                            `Bearer ${MISTRAL_ORGANIZATION_KEY}`
                        );
                        assert.deepEqual(Object.keys(call.body).toSorted(), [
                            'encoding_format',
                            'input',
                            'model',
                        ]);
                        assert.equal(call.body.model, model);
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
                mistral.state.responseModel = 'mistral-embed-2312';
                revision = (
                    await draft(collectionId, { model: 'mistral-embed' })
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
                    name: 'Invalid Mistral dimensions',
                    profile: { ...nativeProfile, dimensions: 1023 },
                });
                const beforeInvalid = mistral.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.start({
                        collectionId: invalid.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    }),
                    failure('DIMENSIONS_UNSUPPORTED')
                );
                assert.equal(mistral.state.calls.length, beforeInvalid);
                const preset = await draft(invalid.id, {
                    dimensions: 1024,
                    embeddingPreset: 'EMBEDDING_GEMMA',
                });
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: invalid.id,
                        expectedRevision: preset.configurationRevision,
                    }),
                    failure('PROFILE_UNSUPPORTED')
                );
                assert.equal(mistral.state.calls.length, beforeInvalid);
                mistral.state.invalidIndex = true;
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
                    mistral.state.invalidIndex = false;
                }
                mistral.state.invalidDimensions = true;
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.probe({
                            collectionId,
                            expectedRevision: revision,
                        }),
                        failure('INVALID_PROVIDER_RESPONSE')
                    );
                } finally {
                    mistral.state.invalidDimensions = false;
                }
                mistral.state.responseModel = 'unreviewed-embed';
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.probe({
                            collectionId,
                            expectedRevision: revision,
                        }),
                        failure('INVALID_PROVIDER_RESPONSE')
                    );
                } finally {
                    mistral.state.responseModel = 'mistral-embed-2312';
                }
                let probeCalls = 0;
                mistral.state.beforeEmbedding = () => {
                    if (++probeCalls === 2)
                        mistral.state.responseModel = 'mistral-embed';
                    return Promise.resolve();
                };
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.probe({
                            collectionId,
                            expectedRevision: revision,
                        }),
                        failure('MODEL_CHANGED')
                    );
                    assert.equal(probeCalls, 2);
                } finally {
                    delete mistral.state.beforeEmbedding;
                    mistral.state.responseModel = 'mistral-embed-2312';
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
            'Mistral discovery and probes fence changed revisions and revoked current management grants after controlled native I/O',
            async () => {
                const race = await f.owner.rag.collections.create({
                    name: 'Mistral revision fence',
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
                        mistral.state.beforeModels = wait;
                    else mistral.state.beforeEmbedding = wait;
                    const pending = f.owner.rag.indexing[operation]({
                        collectionId: race.id,
                        expectedRevision: raceRevision,
                    }).then(
                        () => null,
                        (error: unknown) => error
                    );
                    try {
                        await waitForMistralRequest(entered.promise);
                        raceRevision = (
                            await draft(race.id, {
                                preparation: `Changed while ${operation} was in flight.`,
                            })
                        ).configurationRevision;
                    } finally {
                        delete mistral.state.beforeModels;
                        delete mistral.state.beforeEmbedding;
                        released.resolve();
                    }
                    assert(failure('MODEL_CHANGED')(await pending));
                }
                await f.owner.rag.collections.setGrant({
                    id: race.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: {
                        read: false,
                        manageDocuments: true,
                        administer: false,
                    },
                });
                const entered = Promise.withResolvers<void>();
                const released = Promise.withResolvers<void>();
                mistral.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const revoked = f.manager.rag.indexing
                    .probe({
                        collectionId: race.id,
                        expectedRevision: raceRevision,
                    })
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                try {
                    await waitForMistralRequest(entered.promise);
                    await f.owner.rag.collections.removeGrant({
                        id: race.id,
                        target: { type: 'member', id: f.managerMember },
                    });
                } finally {
                    delete mistral.state.beforeEmbedding;
                    released.resolve();
                }
                const denied = await revoked;
                assert(
                    denied &&
                        typeof denied === 'object' &&
                        'code' in denied &&
                        ['NOT_FOUND', 'FORBIDDEN'].includes(String(denied.code))
                );
            }
        );

        await t.test(
            'Mistral rejects duplicate bulk indices before publication, retries durably and retains exact reordered vector-to-passage association and FR/EN sources',
            async () => {
                activeId = (
                    await f.owner.rag.indexing.start({
                        collectionId,
                        expectedRevision: revision,
                        requestId: randomUUID(),
                    })
                ).generationId;
                mistral.state.duplicateIndex = true;
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
                    mistral.state.duplicateIndex = false;
                    await f.owner.rag.indexing.retry({
                        collectionId,
                        taskId: task.id,
                    });
                    await fixture.scan(8);
                } finally {
                    mistral.state.duplicateIndex = false;
                }
                const status = await f.owner.rag.indexing.status({
                    collectionId,
                });
                assert.equal(status.active?.id, activeId);
                assert.equal(status.unsupportedReason, null);
                assert.equal(status.usage.reservedChunks, 0);
                assert(
                    mistral.state.calls.some(
                        (call) => (call.body.input?.length ?? 0) > 1
                    )
                );
                const result = await f.owner.rag.indexing.search(query);
                assert.equal(result.generationId, activeId);
                assert.equal(result.results.length, 1);
                assert.equal(result.results[0]!.documentId, french.id);
                assert(result.results[0]!.text.includes('needle-mistral'));
                assert.equal(result.results[0]!.scores.vectorDistance, 0);
                sourceReceipt = result.results[0]!.source.receipt;
                assert(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId,
                            receipt: sourceReceipt,
                        })
                    ).text.includes('needle-mistral')
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
                assert.equal(snapshot.schemaVersion, 5);
                assert.equal(snapshot.provider, 'MISTRAL');
                assert.equal(snapshot.identityKind, 'CAPABILITY_PROFILE');
                assert.equal(snapshot.digest, generation.modelIdentity);
                assert.equal(snapshot.dimensions, 1024);
                assert.deepEqual(snapshot.supportedDimensions, [1024]);
                assert.equal(snapshot.contextTokens, 8000);
                assert.equal(snapshot.responseModel, 'mistral-embed-2312');
                assert.equal(snapshot.dimensionCapability, undefined);
                assert.deepEqual(snapshot.batchPolicy, {
                    maxInputs: 64,
                    maxPreparedInputBytes: 16_000,
                    inputTokenReserve: 32,
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
                assert.equal(rest.headers.get('Vectorix-API-Revision'), '13');
                assert.equal(
                    (await rest.json()).results[0].id,
                    result.results[0]!.id
                );
            }
        );

        await t.test(
            'Mistral saved credentials permit key rotation but reject observed-model drift, invalid-key fallback and unapproved destinations',
            async () => {
                await f.owner.rag.indexing.probe({
                    collectionId: platform.id,
                    expectedRevision: 1,
                });
                const platformCalls = mistral.platformCalls();
                assert(platformCalls > 0);
                await f.owner.rag.credentials.update({
                    id: credential.id,
                    expectedRevision: 1,
                    name: credential.name,
                    data: {
                        provider: 'MISTRAL',
                        endpoint: mistral.endpoint,
                        apiKey: MISTRAL_ROTATED_KEY,
                    },
                });
                const rotatedAt = mistral.state.calls.length;
                await f.owner.rag.indexing.search(query);
                assert(
                    mistral.state.calls
                        .slice(rotatedAt)
                        .every(
                            (call) =>
                                call.authorization ===
                                `Bearer ${MISTRAL_ROTATED_KEY}`
                        )
                );
                mistral.state.responseModel = 'mistral-embed';
                try {
                    await assert.rejects(
                        f.owner.rag.indexing.search(query),
                        failure('MODEL_CHANGED')
                    );
                    assert.equal(
                        (await f.owner.rag.indexing.status({ collectionId }))
                            .active?.id,
                        activeId
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
                } finally {
                    mistral.state.responseModel = 'mistral-embed-2312';
                }
                await f.owner.rag.credentials.create({
                    name: 'Invalid Mistral key',
                    data: {
                        provider: 'MISTRAL',
                        endpoint: mistral.endpoint,
                        apiKey: 'invalid-synthetic-key',
                    },
                });
                const broken = await f.owner.rag.collections.create({
                    name: 'Broken Mistral key',
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
                assert.equal(mistral.platformCalls(), platformCalls);
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
                    name: 'Unapproved Mistral destination',
                    data: {
                        provider: 'MISTRAL',
                        endpoint: `${mistral.endpoint}/unapproved`,
                        apiKey: MISTRAL_ORGANIZATION_KEY,
                    },
                });
                const denied = await f.owner.rag.collections.create({
                    name: 'Unapproved Mistral endpoint',
                    profile: nativeProfile,
                });
                assert.equal(
                    denied.configuration.credentialId,
                    deniedCredential.id
                );
                const requestCount = mistral.state.calls.length;
                await assert.rejects(
                    f.owner.rag.indexing.probe({
                        collectionId: denied.id,
                        expectedRevision: 1,
                    }),
                    failure('CREDENTIALS_INVALID')
                );
                assert.equal(mistral.state.calls.length, requestCount);
                await f.owner.rag.credentials.activate({ id: credential.id });
            }
        );

        await t.test(
            'Mistral retrieval uses current collection grants and key scopes after native query I/O',
            async () => {
                const before = mistral.state.calls.length;
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
                assert.equal(mistral.state.calls.length, before);
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Mistral search only',
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
                mistral.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = api.search(query).then(
                    () => null,
                    (error: unknown) => error
                );
                try {
                    await waitForMistralRequest(entered.promise);
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
                    delete mistral.state.beforeEmbedding;
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
            'a captured OpenAI query and exact source survive a failed Mistral successor and explicit retry to schema-five activation',
            async () => {
                await f.owner.rag.credentials.create({
                    name: 'Legacy OpenAI',
                    data: {
                        provider: 'OPENAI',
                        endpoint: legacyOpenAI.endpoint,
                        apiKey: OPENAI_ORGANIZATION_KEY,
                    },
                });
                const legacy = await f.owner.rag.collections.create({
                    name: 'OpenAI to Mistral',
                    profile: {
                        provider: 'OPENAI',
                        model: 'text-embedding-3-small',
                        dimensions: 257,
                    },
                    grantCreatorRead: true,
                });
                const text =
                    'Cross-provider context: protected forests shelter foxes.\n';
                await fixture.upload(
                    text,
                    'mistral-rebuild-source.txt',
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
                legacyOpenAI.state.beforeEmbedding = async () => {
                    entered.resolve();
                    await released.promise;
                };
                const inFlight = f.owner.rag.indexing.search(search).then(
                    (result) => ({ result }),
                    (error: unknown) => ({ error })
                );
                try {
                    await waitForMistralRequest(entered.promise);
                    delete legacyOpenAI.state.beforeEmbedding;
                    const changed = await draft(legacy.id, nativeProfile);
                    const candidate = await f.owner.rag.indexing.rebuild({
                        collectionId: legacy.id,
                        expectedRevision: changed.configurationRevision,
                        expectedActiveGenerationId: first.generationId,
                        requestId: randomUUID(),
                    });
                    mistral.state.rejectEmbeddings = true;
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
                    mistral.state.rejectEmbeddings = false;
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
                    assert.equal(successor.capabilitySnapshot.schemaVersion, 5);
                    assert.equal(
                        successor.capabilitySnapshot.provider,
                        'MISTRAL'
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
                    assert.equal(old.capabilitySnapshot.schemaVersion, 4);
                    assert.equal(old.capabilitySnapshot.provider, 'OPENAI');
                } finally {
                    delete legacyOpenAI.state.beforeEmbedding;
                    mistral.state.rejectEmbeddings = false;
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
        await mistral.close();
        await legacyOpenAI.close();
        if (environment.endpoint === undefined)
            delete process.env.VECTORIX_DEFAULT_MISTRAL_ENDPOINT;
        else
            process.env.VECTORIX_DEFAULT_MISTRAL_ENDPOINT =
                environment.endpoint;
        if (environment.key === undefined)
            delete process.env.VECTORIX_DEFAULT_MISTRAL_API_KEY;
        else process.env.VECTORIX_DEFAULT_MISTRAL_API_KEY = environment.key;
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
