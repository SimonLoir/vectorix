import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f, rpc } from './fixtures';
import { app } from '../app';
import { createIndexingFixture } from './indexing-fixtures';
import { rebuildLockTests } from './index-rebuild-locks';

type Profile = typeof collectionProfile._output;

/** Bound a controlled-provider latch so an implementation regression fails rather than hanging the catalog suite. */
async function entered(promise: Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            promise,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () =>
                        reject(
                            new Error(
                                'Controlled embedding request did not arrive.'
                            )
                        ),
                    5000
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Real catalog/vector/object state verifies a generation switch; the embedding vectors remain explicitly synthetic. */
export async function indexRebuildTests(t: TestContext) {
    const priorOrganization = {
        id: f.org,
        owner: f.ownerMember,
        reader: f.readerMember,
        manager: f.managerMember,
    };
    const organization = await f.owner.post('organization/create', {
        name: `Rebuild isolation ${randomUUID()}`,
        slug: `rebuild-${randomUUID()}`,
    });
    await f.owner.post('organization/set-active', {
        organizationId: organization.id,
    });
    f.org = organization.id;
    f.ownerMember = (await f.owner.client.admin.members.me({})).id;
    const members = await Promise.all([
        prisma.member.create({
            data: {
                id: randomUUID(),
                organizationId: f.org,
                userId: f.users[2]!,
                role: 'member',
                createdAt: new Date(),
            },
        }),
        prisma.member.create({
            data: {
                id: randomUUID(),
                organizationId: f.org,
                userId: f.users[3]!,
                role: 'admin',
                createdAt: new Date(),
            },
        }),
    ]);
    f.readerMember = members[0].id;
    f.managerMember = members[1].id;
    await f.reader.post('organization/set-active', { organizationId: f.org });
    await f.manager.post('organization/set-active', { organizationId: f.org });
    const fixture = await createIndexingFixture();
    assert(
        new URL(process.env.VECTOR_DATABASE_URL!).pathname.endsWith('_test')
    );
    const vector = new Pool({
        connectionString: process.env.VECTOR_DATABASE_URL,
    });
    const collection = await fixture.collection(`Rebuild ${randomUUID()}`);
    const collectionId = collection.id;
    const other = await fixture.collection(
        `Rebuild concurrency ${randomUUID()}`
    );
    let revision = collection.configurationRevision;
    let activeId = '';
    let failedId = '';
    const admissionRequestId = randomUUID();
    let rebuiltId = '';
    let oldReceipt = '';
    let delayedReceipt = '';
    const stableText =
        'Stable context: les forêts protègent les renards. Stable forests protect foxes.\n';
    const stable = await fixture.upload(
        stableText,
        'rebuild-stable.txt',
        collectionId
    );
    const metadata = await fixture.upload(
        'Metadata context: renewable solar energy.\n',
        'rebuild-metadata.txt',
        collectionId
    );
    const replaced = await fixture.upload(
        'Original replacement context in generation A.\n',
        'rebuild-replaced.txt',
        collectionId
    );
    const detached = await fixture.upload(
        'Detach this context before activating the new generation.\n',
        'rebuild-detached.txt',
        collectionId
    );
    const deleted = await fixture.upload(
        'Delete this context before activating the new generation.\n',
        'rebuild-deleted.txt',
        collectionId
    );
    const added = await fixture.upload(
        'New context attached during the rebuild.\n',
        'rebuild-added.txt'
    );
    await fixture.upload(
        'Another collection keeps this context available during a failed retry.\n',
        'rebuild-other.txt',
        other.id
    );
    const replacementVersion = (
        await f.owner.rag.documents.details({ id: replaced.id })
    ).version!.id;
    async function draft(id: string, overrides: Partial<Profile>) {
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
    const search = (strategy: 'HYBRID' | 'LEXICAL' | 'VECTOR' = 'LEXICAL') =>
        f.owner.rag.indexing.search({
            collectionId,
            query: 'context',
            strategy,
            topK: 20,
            filters: {},
        });
    async function table(id: string) {
        const generation = await prisma.indexGeneration.findUniqueOrThrow({
            where: { id },
        });
        return (
            await vector.query<{ table: string | null }>(
                'SELECT to_regclass($1)::text AS table',
                [`${generation.vectorSchema}.${generation.tableName}`]
            )
        ).rows[0]!.table;
    }
    /** Advance only already-retired fixture holds/deadlines; cleanup must still acknowledge every physical operation. */
    async function cleanupGeneration(id: string, expireSources: boolean) {
        if (expireSources) {
            await prisma.documentSourceHold.updateMany({
                where: {
                    indexedDocument: { generationId: id },
                    state: 'RETIRED',
                },
                data: { retainUntil: new Date(0) },
            });
            await prisma.indexGeneration.updateMany({
                where: { id, status: 'RETIRED' },
                data: { cleanupAfter: new Date(0) },
            });
        }
        for (let pass = 0; pass < 30; pass++) {
            await prisma.indexTask.updateMany({
                where: {
                    generationId: id,
                    status: 'PENDING',
                    kind: { in: ['CLEAN_GENERATION', 'CLEAN_PUBLICATION'] },
                },
                data: { availableAt: new Date(0) },
            });
            await fixture.scan(1);
            if (
                (
                    await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id },
                    })
                ).status === 'CLEANED'
            )
                return;
        }
        assert.fail(
            'The isolated generation did not acknowledge physical cleanup.'
        );
    }
    try {
        await draft(collectionId, {
            metadataFields: {
                category: 'STRING',
                priority: 'NUMBER',
                legacy: 'STRING',
            },
        });
        revision++;
        await f.owner.rag.indexing.updateMetadata({
            collectionId,
            documentId: metadata.id,
            expectedMetadataRevision: 1,
            language: 'EN',
            tags: ['initial'],
            metadata: {
                category: 'initial',
                priority: 1,
                legacy: 'original-only',
            },
        });
        activeId = (
            await f.owner.rag.indexing.start({
                collectionId,
                expectedRevision: revision,
                requestId: randomUUID(),
            })
        ).generationId;
        await fixture.scan(8);
        const otherStarted = await f.owner.rag.indexing.start({
            collectionId: other.id,
            expectedRevision: 1,
            requestId: randomUUID(),
        });
        await fixture.scan(4);
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId })).active?.id,
            activeId
        );
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId: other.id }))
                .active?.id,
            otherStarted.generationId
        );
        oldReceipt = (await search()).results.find(
            (row) => row.documentId === stable.id
        )!.source.receipt;
        await t.test(
            'profile changes remain a draft while A serves; incompatible shared metadata types fail before accepting a revision',
            async () => {
                const changed = await draft(collectionId, {
                    preparation: 'Rebuild profile B',
                    metadataFields: {
                        category: 'STRING',
                        priority: 'NUMBER',
                        extra: 'BOOLEAN',
                    },
                });
                revision = changed.configurationRevision;
                assert.equal((await search()).generationId, activeId);
                assert.equal(
                    (await f.owner.rag.indexing.status({ collectionId })).active
                        ?.configurationRevision,
                    revision - 1
                );
                await assert.rejects(
                    draft(collectionId, {
                        metadataFields: {
                            category: 'NUMBER',
                            priority: 'NUMBER',
                        },
                    }),
                    { code: 'CONFLICT' }
                );
                assert.equal(
                    (await f.owner.rag.collections.get({ id: collectionId }))
                        .configurationRevision,
                    revision
                );
                await draft(other.id, {
                    preparation: 'Other collection candidate',
                });
            }
        );
        await t.test(
            'organization admission and discard remain compatible with activation locks and cannot undo a concurrent suspension',
            async () => {
                const accepted = await rebuildLockTests({
                    collectionId,
                    expectedRevision: revision,
                    activeGenerationId: activeId,
                    requestId: admissionRequestId,
                });
                failedId = accepted.generationId;
            }
        );
        await t.test(
            'rebuild acceptance enforces current session permissions, organization isolation and immutable request-id replay',
            async () => {
                const previousRole = (
                    await prisma.member.findUniqueOrThrow({
                        where: { id: f.readerMember },
                    })
                ).role;
                const role = await prisma.organizationRole.create({
                    data: {
                        id: randomUUID(),
                        organizationId: f.org,
                        role: `rebuild-${randomUUID()}`,
                        permission: JSON.stringify({
                            ragCollection: ['manageDocuments'],
                            ragLibrary: ['read'],
                            apiKey: ['create', 'read'],
                        }),
                    },
                });
                await prisma.member.update({
                    where: { id: f.readerMember },
                    data: { role: role.role },
                });
                await f.owner.rag.collections.setGrant({
                    id: collectionId,
                    target: { type: 'member', id: f.readerMember },
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: true,
                    },
                });
                try {
                    await assert.rejects(
                        f.reader.rag.indexing.rebuild({
                            collectionId,
                            expectedRevision: revision,
                            expectedActiveGenerationId: activeId,
                            requestId: randomUUID(),
                        }),
                        { code: 'FORBIDDEN' }
                    );
                    await prisma.organizationRole.update({
                        where: { id: role.id },
                        data: {
                            permission: JSON.stringify({
                                ragCollection: [
                                    'read',
                                    'manageDocuments',
                                    'update',
                                ],
                                ragLibrary: ['read'],
                                apiKey: ['create', 'read'],
                            }),
                        },
                    });
                    for (const permissions of [
                        {
                            read: true,
                            manageDocuments: true,
                            administer: false,
                        },
                        {
                            read: true,
                            manageDocuments: false,
                            administer: true,
                        },
                    ]) {
                        await f.owner.rag.collections.setGrant({
                            id: collectionId,
                            target: { type: 'member', id: f.readerMember },
                            permissions,
                        });
                        await assert.rejects(
                            f.reader.rag.indexing.rebuild({
                                collectionId,
                                expectedRevision: revision,
                                expectedActiveGenerationId: activeId,
                                requestId: randomUUID(),
                            })
                        );
                    }
                    await f.owner.rag.collections.setGrant({
                        id: collectionId,
                        target: { type: 'member', id: f.readerMember },
                        permissions: {
                            read: true,
                            manageDocuments: true,
                            administer: true,
                        },
                    });
                    await assert.rejects(
                        f.reader.client.admin.organization.apiKeys.create({
                            name: 'Cannot mint session administration',
                            permissions: {
                                ragCollection: ['manageDocuments', 'update'],
                                ragLibrary: ['read'],
                            },
                            collectionScopes: [
                                {
                                    collectionId,
                                    read: true,
                                    manageDocuments: true,
                                },
                            ],
                        })
                    );
                    const key =
                        await f.reader.client.admin.organization.apiKeys.create(
                            {
                                name: 'Session-only rebuild denial',
                                permissions: {
                                    ragCollection: ['read', 'manageDocuments'],
                                    ragLibrary: ['read'],
                                },
                                collectionScopes: [
                                    {
                                        collectionId,
                                        read: true,
                                        manageDocuments: true,
                                    },
                                ],
                            }
                        );
                    const api = rpc(() => ({ 'x-api-key': key.key })).admin.rag
                        .indexing;
                    await assert.rejects(
                        api.rebuild({
                            collectionId,
                            expectedRevision: revision,
                            expectedActiveGenerationId: activeId,
                            requestId: randomUUID(),
                        }),
                        { code: 'FORBIDDEN' }
                    );
                    await assert.rejects(
                        f.other.rag.indexing.rebuild({
                            collectionId,
                            expectedRevision: revision,
                            expectedActiveGenerationId: activeId,
                            requestId: randomUUID(),
                        })
                    );
                    await assert.rejects(
                        f.manager.rag.indexing.rebuild({
                            collectionId,
                            expectedRevision: revision,
                            expectedActiveGenerationId: activeId,
                            requestId: randomUUID(),
                        })
                    );
                    const requestId = admissionRequestId;
                    const request = {
                        collectionId,
                        expectedRevision: revision,
                        expectedActiveGenerationId: activeId,
                        requestId,
                    };
                    const accepted =
                        await f.owner.rag.indexing.rebuild(request);
                    failedId = accepted.generationId;
                    await assert.rejects(
                        api.discard({ collectionId, generationId: failedId }),
                        { code: 'FORBIDDEN' }
                    );
                    assert.equal(
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: failedId },
                            })
                        ).previousGenerationId,
                        activeId
                    );
                    const calls = fixture.state.embedCalls;
                    assert.deepEqual(
                        await f.owner.rag.indexing.rebuild(request),
                        accepted
                    );
                    assert.equal(
                        fixture.state.embedCalls,
                        calls,
                        'Replaying acceptance must not repeat model probes.'
                    );
                    const restReplay = await app.request(
                        `/api/v1/admin/rag/collections/${collectionId}/index-rebuilds`,
                        {
                            method: 'POST',
                            headers: {
                                ...f.owner.headers(),
                                'content-type': 'application/json',
                            },
                            body: JSON.stringify({
                                expectedRevision: revision,
                                expectedActiveGenerationId: activeId,
                                requestId,
                            }),
                        }
                    );
                    assert.equal(
                        restReplay.status,
                        200,
                        await restReplay.clone().text()
                    );
                    assert.deepEqual(await restReplay.json(), accepted);
                    const spec = await (
                        await app.request('/spec/v1.json')
                    ).json();
                    assert.equal(
                        restReplay.headers.get('Vectorix-API-Revision'),
                        String(spec.info.version).split('.')[1]
                    );
                    assert(
                        spec.paths[
                            '/admin/rag/collections/{collectionId}/index-rebuilds'
                        ].post
                    );
                    assert(
                        spec.paths[
                            '/admin/rag/collections/{collectionId}/index-generations/{generationId}/discard'
                        ].post
                    );

                    await assert.rejects(
                        f.owner.rag.indexing.rebuild({
                            ...request,
                            expectedActiveGenerationId: randomUUID(),
                        }),
                        { code: 'CONFLICT' }
                    );
                    await assert.rejects(
                        f.owner.rag.indexing.rebuild({
                            ...request,
                            requestId: randomUUID(),
                        }),
                        { code: 'CONFLICT' }
                    );
                    await assert.rejects(
                        f.owner.rag.indexing.rebuild({
                            collectionId: other.id,
                            expectedRevision: 2,
                            expectedActiveGenerationId:
                                otherStarted.generationId,
                            requestId: randomUUID(),
                        }),
                        { code: 'CONFLICT' }
                    );
                    await assert.rejects(
                        draft(collectionId, {
                            preparation: 'Forbidden during candidate build',
                        }),
                        { code: 'CONFLICT' }
                    );
                    await assert.rejects(
                        f.reader.rag.indexing.discard({
                            collectionId,
                            generationId: activeId,
                        })
                    );
                    assert.equal(
                        (await f.owner.rag.indexing.status({ collectionId }))
                            .active?.id,
                        activeId
                    );
                } finally {
                    await prisma.member.update({
                        where: { id: f.readerMember },
                        data: { role: previousRole },
                    });
                }
            }
        );
        await t.test(
            'a failed candidate keeps A usable; discard tombstones B before releasing its retained quota and exact source holds',
            async () => {
                await fixture.scan(1);
                fixture.state.beforeEmbedding = async () => {
                    if (
                        (await prisma.indexedDocument.count({
                            where: {
                                generationId: failedId,
                                status: 'PUBLISHED',
                            },
                        })) >= 2
                    )
                        fixture.state.rejectEmbeddings = true;
                };
                try {
                    await fixture.scan(1);
                    assert.equal(
                        await prisma.indexedDocument.count({
                            where: {
                                generationId: failedId,
                                status: 'PUBLISHED',
                            },
                        }),
                        2
                    );
                    assert.equal(
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: failedId },
                            })
                        ).activatedAt,
                        null
                    );
                    const task = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId: failedId,
                            kind: 'INDEX_DOCUMENT',
                            errorCode: 'PROVIDER_REJECTED',
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
                    const beforeCrash =
                        await prisma.collectionIndexAccounting.findUniqueOrThrow(
                            { where: { collectionId } }
                        );
                    const expired = await prisma.indexTask.findUniqueOrThrow({
                        where: { id: task.id },
                    });
                    // Reconstruct an interrupted worker after durable materialization:
                    // only its PostgreSQL lease expires; chunks, reservations,
                    // exact source holds and the real vector stage remain intact.
                    await prisma.indexTask.update({
                        where: { id: task.id },
                        data: {
                            status: 'PROCESSING',
                            attempts: 4,
                            leaseToken: 'terminated-rebuild-worker',
                            leasedUntil: new Date(0),
                            availableAt: new Date(0),
                        },
                    });
                    await fixture.scan(1);
                    const reclaimed = await prisma.indexTask.findUniqueOrThrow({
                        where: { id: task.id },
                    });
                    assert(reclaimed.leaseEpoch > expired.leaseEpoch);
                    assert.equal(reclaimed.status, 'FAILED');
                    const afterCrash =
                        await prisma.collectionIndexAccounting.findUniqueOrThrow(
                            { where: { collectionId } }
                        );
                    assert.equal(
                        afterCrash.activeChunks,
                        beforeCrash.activeChunks
                    );
                    assert.equal(
                        afterCrash.retainedChunks,
                        beforeCrash.retainedChunks
                    );
                    assert.equal(
                        afterCrash.reservedChunks,
                        beforeCrash.reservedChunks
                    );
                    assert.equal(
                        (
                            await prisma.documentSourceHold.findUniqueOrThrow({
                                where: {
                                    indexedDocumentId: task.indexedDocumentId!,
                                },
                            })
                        ).state,
                        'LIVE'
                    );
                    const active = await search();
                    assert.equal(active.generationId, activeId);
                    assert(
                        active.results.some(
                            (row) => row.documentId === stable.id
                        )
                    );
                    const usage =
                        await prisma.collectionIndexAccounting.findUniqueOrThrow(
                            { where: { collectionId } }
                        );
                    assert(
                        usage.activeChunks > 0n && usage.retainedChunks > 0n
                    );
                    assert(await table(activeId));
                    assert(await table(failedId));
                } finally {
                    delete fixture.state.beforeEmbedding;
                    fixture.state.rejectEmbeddings = false;
                }
                assert.equal((await search('HYBRID')).generationId, activeId);
                // Keep the unfinished candidates deferred while one published
                // B document is superseded. This generation never served search,
                // so neither this old publication nor its discard needs citation grace.
                await prisma.indexTask.updateMany({
                    where: {
                        generationId: failedId,
                        kind: 'INDEX_DOCUMENT',
                        status: 'PENDING',
                    },
                    data: { availableAt: new Date(Date.now() + 60_000) },
                });
                const superseded =
                    await prisma.indexedDocument.findFirstOrThrow({
                        where: {
                            generationId: failedId,
                            status: 'PUBLISHED',
                            documentId: { not: metadata.id },
                        },
                    });
                const association =
                    await prisma.collectionDocument.findUniqueOrThrow({
                        where: {
                            ['collectionId_documentId']: {
                                collectionId,
                                documentId: superseded.documentId,
                            },
                        },
                    });
                await f.owner.rag.indexing.updateMetadata({
                    collectionId,
                    documentId: superseded.documentId,
                    expectedMetadataRevision: association.metadataRevision,
                    language: association.language,
                    tags: ['partial-build'],
                    metadata: { category: 'partial', priority: 7, extra: true },
                });
                await fixture.scan(1);
                const retired = await prisma.indexedDocument.findUniqueOrThrow({
                    where: { id: superseded.id },
                    include: { sourceHold: true },
                });
                assert.equal(retired.status, 'RETIRED');
                assert(
                    retired.sourceHold!.retainUntil! <= new Date(),
                    'A never-activated publication must not receive a 17-minute citation deadline.'
                );
                await fixture.scan(1);
                assert.equal(
                    (
                        await prisma.indexedDocument.findUniqueOrThrow({
                            where: { id: superseded.id },
                        })
                    ).status,
                    'CLEANED'
                );
                assert.equal(
                    (
                        await prisma.documentSourceHold.findUniqueOrThrow({
                            where: { indexedDocumentId: superseded.id },
                        })
                    ).state,
                    'RELEASED'
                );

                await assert.rejects(
                    f.owner.rag.indexing.discard({
                        collectionId,
                        generationId: activeId,
                    }),
                    { code: 'CONFLICT' }
                );
                await f.owner.rag.indexing.discard({
                    collectionId,
                    generationId: failedId,
                });
                const discardedRest = await app.request(
                    `/api/v1/admin/rag/collections/${collectionId}/index-generations/${failedId}/discard`,
                    {
                        method: 'POST',
                        headers: {
                            ...f.owner.headers(),
                            'content-type': 'application/json',
                        },
                        body: '{}',
                    }
                );
                assert.equal(
                    discardedRest.status,
                    200,
                    await discardedRest.clone().text()
                );
                assert.deepEqual(await discardedRest.json(), { success: true });
                await cleanupGeneration(failedId, false);
                assert.equal(await table(failedId), null);
                assert(await table(activeId));
                assert.equal((await search()).generationId, activeId);
                assert.equal(
                    await prisma.documentSourceHold.count({
                        where: {
                            indexedDocument: { generationId: failedId },
                            state: { not: 'RELEASED' },
                        },
                    }),
                    0
                );
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId },
                    });
                const retainedA = await prisma.indexedDocument.aggregate({
                    where: {
                        generationId: activeId,
                        status: { in: ['RETIRED', 'CLEANING'] },
                    },
                    _sum: { materializedChunks: true },
                });
                assert.equal(
                    usage.retainedChunks,
                    BigInt(retainedA._sum.materializedChunks ?? 0)
                );
                assert.equal(usage.reservedChunks, 0n);
            }
        );
        await t.test(
            'ordered catch-up includes changes accepted during B while an in-flight A query and exact source survive the switch',
            async () => {
                const queryEntered = Promise.withResolvers<void>();
                const queryReleased = Promise.withResolvers<void>();
                fixture.state.beforeEmbedding = async () => {
                    queryEntered.resolve();
                    await queryReleased.promise;
                };
                const pendingQuery = f.owner.rag.indexing
                    .search({
                        collectionId,
                        query: 'stable context',
                        strategy: 'HYBRID',
                        topK: 5,
                        filters: { documentIds: [stable.id] },
                    })
                    .then(
                        (result) => ({ result }),
                        (error: unknown) => ({ error })
                    );
                try {
                    await entered(queryEntered.promise);
                    delete fixture.state.beforeEmbedding;
                    rebuiltId = (
                        await f.owner.rag.indexing.rebuild({
                            collectionId,
                            expectedRevision: revision,
                            expectedActiveGenerationId: activeId,
                            requestId: randomUUID(),
                        })
                    ).generationId;
                    await fixture.scan(1);
                    const indexEntered = Promise.withResolvers<void>();
                    const indexReleased = Promise.withResolvers<void>();
                    fixture.state.beforeEmbedding = async () => {
                        indexEntered.resolve();
                        await indexReleased.promise;
                    };
                    const indexing = fixture.scan(1).then(
                        () => null,
                        (error: unknown) => error
                    );
                    try {
                        await entered(indexEntered.promise);
                        delete fixture.state.beforeEmbedding;
                        assert.equal(
                            (
                                await f.owner.rag.indexing.status({
                                    collectionId,
                                })
                            ).active?.id,
                            activeId
                        );
                        await f.owner.rag.indexing.updateMetadata({
                            collectionId,
                            documentId: metadata.id,
                            expectedMetadataRevision: 2,
                            language: 'EN',
                            tags: ['changed'],
                            metadata: {
                                category: 'updated',
                                priority: 9,
                                extra: true,
                            },
                        });
                        await f.manager.rag.documents.replace({
                            id: replaced.id,
                            expectedVersionId: replacementVersion,
                            requestId: randomUUID(),
                            file: new File(
                                [
                                    'Fresh replacement context written while generation B is building.\n',
                                ],
                                'rebuild-replaced-v2.txt'
                            ),
                            retentionDays: 0,
                        });
                        await processDocumentIngestions(prisma);
                        await f.owner.rag.documents.setCollection({
                            id: added.id,
                            collectionId,
                            attached: true,
                        });
                        await f.owner.rag.documents.setCollection({
                            id: detached.id,
                            collectionId,
                            attached: false,
                        });
                        await f.owner.rag.documents.delete({
                            id: deleted.id,
                            expectedVersionId: (
                                await f.owner.rag.documents.details({
                                    id: deleted.id,
                                })
                            ).version!.id,
                            retentionDays: 0,
                        });
                    } finally {
                        delete fixture.state.beforeEmbedding;
                        indexReleased.resolve();
                    }
                    const indexingError = await indexing;
                    if (indexingError) throw indexingError;
                    await fixture.scan(12);
                    const status = await f.owner.rag.indexing.status({
                        collectionId,
                    });
                    assert.equal(status.active?.id, rebuiltId);
                    const a = await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: activeId },
                    });
                    const b = await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: rebuiltId },
                    });
                    const current = await prisma.collection.findUniqueOrThrow({
                        where: { id: collectionId },
                    });
                    assert.equal(a.status, 'RETIRED');
                    assert.equal(b.status, 'ACTIVE');
                    assert.equal(b.authorityUserId, f.users[0]);
                    const replacementTask =
                        await prisma.indexTask.findFirstOrThrow({
                            where: {
                                generationId: rebuiltId,
                                kind: 'INDEX_DOCUMENT',
                                indexedDocument: {
                                    documentId: replaced.id,
                                    sourceVersion: { version: 2 },
                                },
                            },
                        });
                    assert.equal(
                        replacementTask.requestedBy,
                        f.users[0],
                        'The accepted rebuild task retains its authorized owner.'
                    );
                    const replacedPublication =
                        await prisma.indexedDocument.findUniqueOrThrow({
                            where: { id: replacementTask.indexedDocumentId! },
                        });
                    const replacementIngestion =
                        await prisma.documentIngestion.findUniqueOrThrow({
                            where: {
                                versionId: replacedPublication.sourceVersionId,
                            },
                        });
                    assert.equal(
                        replacementIngestion.requestedBy,
                        f.users[3],
                        'The source replacement was published by a library manager without collection administration grants.'
                    );

                    assert.equal(b.appliedSequence, current.contentSequence);
                    assert.equal(
                        await prisma.generationChange.count({
                            where: {
                                generationId: rebuiltId,
                                status: 'PENDING',
                            },
                        }),
                        0
                    );
                    const published = await prisma.generationDocument.findMany({
                        where: { generationId: rebuiltId, removedAt: null },
                        include: { publishedIndexedDocument: true },
                    });
                    assert.deepEqual(
                        published.map((row) => row.documentId).toSorted(),
                        [
                            stable.id,
                            metadata.id,
                            replaced.id,
                            added.id,
                        ].toSorted()
                    );
                    assert(
                        published.every(
                            (row) =>
                                row.publishedIndexedDocument
                                    ?.sourceVersionId ===
                                    row.desiredVersionId &&
                                row.publishedIndexedDocument
                                    .metadataRevision ===
                                    row.desiredMetadataRevision
                        )
                    );
                    const changed = published.find(
                        (row) => row.documentId === metadata.id
                    )!.publishedIndexedDocument!;
                    assert.deepEqual(changed.metadata, {
                        category: 'updated',
                        priority: 9,
                        extra: true,
                    });
                    assert.equal(changed.metadataRevision, 3);
                    const aMetadata =
                        await prisma.generationDocument.findUniqueOrThrow({
                            where: {
                                ['generationId_documentId']: {
                                    generationId: activeId,
                                    documentId: metadata.id,
                                },
                            },
                            include: { publishedIndexedDocument: true },
                        });
                    assert.deepEqual(
                        aMetadata.publishedIndexedDocument?.metadata,
                        { category: 'updated', priority: 9 }
                    );
                    assert.equal(
                        (
                            await prisma.documentVersion.findUniqueOrThrow({
                                where: {
                                    id: published.find(
                                        (row) => row.documentId === replaced.id
                                    )!.desiredVersionId!,
                                },
                            })
                        ).version,
                        2
                    );
                    assert(await table(activeId));
                    assert(await table(rebuiltId));
                    const currentSearch = await search();
                    assert.equal(currentSearch.generationId, rebuiltId);
                    assert(
                        !currentSearch.results.some((row) =>
                            [detached.id, deleted.id].includes(row.documentId)
                        )
                    );
                } finally {
                    delete fixture.state.beforeEmbedding;
                    queryReleased.resolve();
                }
                const completedQuery = await pendingQuery;
                if ('error' in completedQuery) throw completedQuery.error;
                assert.equal(
                    completedQuery.result.generationId,
                    activeId,
                    'A captured request must not silently switch to generation B.'
                );
                assert(completedQuery.result.results.length > 0);
                assert(
                    completedQuery.result.results.every(
                        (row) => row.documentId === stable.id
                    )
                );
                const result = completedQuery.result.results[0]!;
                assert.equal(
                    (
                        await prisma.indexedDocument.findUniqueOrThrow({
                            where: { id: result.publicationId },
                        })
                    ).generationId,
                    activeId
                );
                delayedReceipt = result.source.receipt;
                for (const receipt of [oldReceipt, delayedReceipt]) {
                    assert.equal(
                        (
                            await f.owner.rag.indexing.sourcePreview({
                                collectionId,
                                receipt,
                                offset: 0,
                            })
                        ).text,
                        stableText
                    );
                    assert.equal(
                        await (
                            await f.owner.rag.indexing.sourceOriginal({
                                collectionId,
                                receipt,
                            })
                        ).text(),
                        stableText
                    );
                }
                const a = await prisma.indexGeneration.findUniqueOrThrow({
                    where: { id: activeId },
                });
                assert(a.cleanupAfter! > new Date(Date.now() + 15 * 60_000));
                assert(
                    await prisma.documentSourceHold.count({
                        where: {
                            indexedDocument: { generationId: activeId },
                            state: 'RETIRED',
                            retainUntil: {
                                gt: new Date(Date.now() + 15 * 60_000),
                            },
                        },
                    })
                );
            }
        );
        await t.test(
            'old tables count toward the two-table bound until physical cleanup; expired A sources do not prevent C from serving',
            async () => {
                const next = await draft(collectionId, {
                    preparation: 'Next rebuild after old table cleanup',
                });
                revision = next.configurationRevision;
                await assert.rejects(
                    f.owner.rag.indexing.rebuild({
                        collectionId,
                        expectedRevision: revision,
                        expectedActiveGenerationId: rebuiltId,
                        requestId: randomUUID(),
                    }),
                    { code: 'CONFLICT' }
                );
                assert.equal((await search()).generationId, rebuiltId);
                await cleanupGeneration(activeId, true);
                assert.equal(await table(activeId), null);
                assert(await table(rebuiltId));
                await assert.rejects(
                    f.owner.rag.indexing.sourcePreview({
                        collectionId,
                        receipt: delayedReceipt,
                        offset: 0,
                    })
                );
                assert.equal((await search()).generationId, rebuiltId);
                const usage =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId },
                    });
                assert(usage.activeChunks > 0n);
                assert.equal(usage.retainedChunks + usage.reservedChunks, 0n);
                const nextGeneration = await f.owner.rag.indexing.rebuild({
                    collectionId,
                    expectedRevision: revision,
                    expectedActiveGenerationId: rebuiltId,
                    requestId: randomUUID(),
                });
                await f.owner.rag.indexing.discard({
                    collectionId,
                    generationId: nextGeneration.generationId,
                });
                await cleanupGeneration(nextGeneration.generationId, false);
                assert.equal(
                    await table(nextGeneration.generationId),
                    null,
                    'Discard before provisioning must leave a permanent tombstone rather than a late-created table.'
                );
                assert.equal((await search()).generationId, rebuiltId);
            }
        );
        await t.test(
            'a failed rebuild can be retried to completion without losing A or duplicating materialized chunk reservations',
            async () => {
                const otherId = other.id;
                const rebuilding = await f.owner.rag.indexing.rebuild({
                    collectionId: otherId,
                    expectedRevision: 2,
                    expectedActiveGenerationId: otherStarted.generationId,
                    requestId: randomUUID(),
                });
                await fixture.scan(1);
                fixture.state.rejectEmbeddings = true;
                let taskId: string;
                try {
                    await fixture.scan(1);
                    const failed = await prisma.indexTask.findFirstOrThrow({
                        where: {
                            generationId: rebuilding.generationId,
                            kind: 'INDEX_DOCUMENT',
                            errorCode: 'PROVIDER_REJECTED',
                        },
                    });
                    taskId = failed.id;
                    await prisma.indexTask.update({
                        where: { id: failed.id },
                        data: { attempts: 4, availableAt: new Date(0) },
                    });
                    await fixture.scan(1);
                    assert.equal(
                        (
                            await prisma.indexTask.findUniqueOrThrow({
                                where: { id: taskId },
                            })
                        ).status,
                        'FAILED'
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: otherId,
                            })
                        ).active?.id,
                        otherStarted.generationId
                    );
                } finally {
                    fixture.state.rejectEmbeddings = false;
                }
                const before =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: otherId },
                    });
                assert(before.retainedChunks > 0n);
                await f.owner.rag.indexing.retry({
                    collectionId: otherId,
                    taskId,
                });
                await fixture.scan(6);
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: otherId,
                        })
                    ).active?.id,
                    rebuilding.generationId
                );
                const after =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: otherId },
                    });
                assert.equal(after.reservedChunks, 0n);
                assert.equal(
                    after.activeChunks + after.retainedChunks,
                    before.activeChunks + before.retainedChunks
                );
                assert.equal(
                    await prisma.indexedDocument.count({
                        where: {
                            generationId: rebuilding.generationId,
                            status: 'PUBLISHED',
                        },
                    }),
                    1
                );
            }
        );
    } finally {
        await vector.end();
        await fixture.close();
        f.org = priorOrganization.id;
        f.ownerMember = priorOrganization.owner;
        f.readerMember = priorOrganization.reader;
        f.managerMember = priorOrganization.manager;
        await f.owner.post('organization/set-active', {
            organizationId: f.org,
        });
        await f.reader.post('organization/set-active', {
            organizationId: f.org,
        });
        await f.manager.post('organization/set-active', {
            organizationId: f.org,
        });
    }
}
