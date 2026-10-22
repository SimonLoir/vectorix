import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@repo/db';
import { fixture as f, rpc } from './fixtures';
import { parentText } from './parent-fixtures';
import { semanticLatch } from './semantic-fixtures';
import {
    assertSyncDenied,
    assertSyncVersion,
    createSyncFixture,
    currentSyncTask,
    replaceSyncSource,
    scanSync,
    startSyncCollection,
    syncManageGrant,
    syncReadGrant,
} from './sync-authority-fixtures';

/** Ordinary retry is a task override; only explicit adoption changes the controller for later automatic events. */
export async function syncAuthorityRecoveryTests(t: TestContext) {
    await t.test(
        'task-only recovery works independently while explicit atomic adoption controls future updates without resetting FAILED work',
        async () => {
            const fixture = await createSyncFixture('Retry versus adoption');
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Durable synchronization adoption',
                });
                const secondSource = await fixture.upload(
                    `${parentText}\nSecond source v1.`,
                    'sync-second-source.txt',
                    entry.collection.id
                );
                await scanSync(fixture, [entry.generationId]);
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: syncReadGrant,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nTask override v2.`
                );
                const calls = fixture.state.embedCalls;
                await scanSync(fixture, [entry.generationId], 2);
                const failed = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(failed.status, 'FAILED');
                assert.equal(failed.errorCode, 'ACCESS_REVOKED');
                assert.equal(fixture.state.embedCalls, calls);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    1
                );
                const freshness = await f.owner.rag.indexing.documents({
                    collectionId: entry.collection.id,
                    query: '',
                    limit: 20,
                    offset: 0,
                });
                const document = freshness.items.find(
                    (row) => row.documentId === entry.documentId
                );
                assert.equal(document?.libraryVersion, 2);
                assert(document);
                assert.equal(document.indexedVersion, 1);
                assert.equal(document.errorCode, 'ACCESS_REVOKED');
                assert.equal(document.pending, true);
                assert.equal(document.freshness, 'BLOCKED');
                assert.equal(document.desiredVersion, 2);
                assert(document.pendingSince instanceof Date);
                assert(document.indexedAt instanceof Date);
                assert.equal(
                    document.retryTaskId,
                    null,
                    'Read-only sessions must not receive actionable retry identifiers.'
                );
                const readerStatus = await f.owner.rag.indexing.status({
                    collectionId: entry.collection.id,
                });
                assert.equal(
                    readerStatus.active?.synchronization?.authorityState,
                    'ACCESS_REVOKED'
                );
                assert.equal(
                    readerStatus.active?.synchronization?.authorityUserId,
                    undefined
                );
                assert.equal(
                    readerStatus.active?.synchronization?.canAdopt,
                    false
                );
                const managerDocuments = await f.manager.rag.indexing.documents(
                    {
                        collectionId: entry.collection.id,
                        query: '',
                        limit: 20,
                        offset: 0,
                    }
                );
                assert.equal(
                    managerDocuments.items.find(
                        (row) => row.documentId === entry.documentId
                    )?.retryTaskId,
                    failed.id
                );
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: failed.id,
                });
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
                assert.equal(
                    (
                        await currentSyncTask(
                            entry.generationId,
                            entry.documentId
                        )
                    ).requestedBy,
                    f.users[3]
                );
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).authorityUserId,
                    f.users[0]
                );

                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nAdoption anchor v3.`
                );
                await scanSync(fixture, [entry.generationId], 2);
                const anchor = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(anchor.status, 'FAILED');
                assert.equal(anchor.requestedBy, f.users[0]);
                await replaceSyncSource(
                    fixture,
                    secondSource.id,
                    `${parentText}\nQueued source v2.`
                );
                const pending = await currentSyncTask(
                    entry.generationId,
                    secondSource.id
                );
                assert.equal(pending.status, 'PENDING');
                const blocked = await f.manager.rag.indexing.status({
                    collectionId: entry.collection.id,
                });
                assert.equal(blocked.active?.synchronization?.blockedTasks, 1);
                const identifier = `sync_audit_${randomUUID().replaceAll('-', '')}`;
                for (const value of [f.org, f.users[3]!, entry.collection.id])
                    assert.match(value, /^[A-Za-z\d-]{1,191}$/u);
                assert.match(identifier, /^[a-z_][a-z\d_]{0,62}$/u);
                const beforeTasks = await prisma.indexTask.findMany({
                    where: { generationId: entry.generationId },
                    orderBy: { id: 'asc' },
                });
                // Narrow test-only audit fault; SQL DDL is not expressible by Prisma and is removed in finally.
                await prisma.$executeRawUnsafe(
                    `CREATE FUNCTION "${identifier}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."organizationId"='${f.org}' AND NEW."actorId"='${f.users[3]}' AND NEW."targetId"='${entry.collection.id}' AND NEW.action='collection.index.synchronization.adopted' THEN RAISE EXCEPTION 'owned synchronization audit fault'; END IF; RETURN NEW; END $$`
                );
                try {
                    await prisma.$executeRawUnsafe(
                        `CREATE TRIGGER "${identifier}" BEFORE INSERT ON "RagAuditLog" FOR EACH ROW EXECUTE FUNCTION "${identifier}"()`
                    );
                    try {
                        await assert.rejects(
                            f.manager.rag.indexing.adoptSynchronization({
                                collectionId: entry.collection.id,
                                generationId: entry.generationId,
                                expectedAuthorityUserId: f.users[0]!,
                            })
                        );
                        assert.equal(
                            (
                                await prisma.indexGeneration.findUniqueOrThrow({
                                    where: { id: entry.generationId },
                                })
                            ).authorityUserId,
                            f.users[0]
                        );
                        assert.ok(
                            isDeepStrictEqual(
                                await prisma.indexTask.findMany({
                                    where: { generationId: entry.generationId },
                                    orderBy: { id: 'asc' },
                                }),
                                beforeTasks
                            ),
                            'Failed audit must roll back every task change without printing internal lease tokens.'
                        );
                    } finally {
                        await prisma.$executeRawUnsafe(
                            `DROP TRIGGER IF EXISTS "${identifier}" ON "RagAuditLog"`
                        );
                    }
                } finally {
                    await prisma.$executeRawUnsafe(
                        `DROP FUNCTION "${identifier}"()`
                    );
                }
                const adopted =
                    await f.manager.rag.indexing.adoptSynchronization({
                        collectionId: entry.collection.id,
                        generationId: entry.generationId,
                        expectedAuthorityUserId: f.users[0]!,
                    });
                assert.equal(adopted.authorityUserId, f.users[3]);
                assert.equal(adopted.interruptedTasks, 0);
                assert.equal(adopted.reboundPendingTasks, 1);
                assert.equal(
                    (await currentSyncTask(entry.generationId, secondSource.id))
                        .leaseEpoch,
                    pending.leaseEpoch + 1n
                );
                const unchanged = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(unchanged.status, 'FAILED');
                assert.equal(unchanged.attempts, anchor.attempts);
                assert.equal(unchanged.leaseEpoch, anchor.leaseEpoch);
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: anchor.id,
                });
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    3
                );
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nAutomatically adopted v4.`
                );
                assert.equal(
                    (
                        await currentSyncTask(
                            entry.generationId,
                            entry.documentId
                        )
                    ).requestedBy,
                    f.users[3]
                );
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    4
                );
                await assertSyncVersion(entry.generationId, secondSource.id, 2);
                const ready = await f.manager.rag.indexing.status({
                    collectionId: entry.collection.id,
                });
                assert.equal(
                    ready.active?.synchronization?.pendingDocuments,
                    0
                );
                assert.equal(ready.active?.synchronization?.blockedTasks, 0);
                assert.equal(
                    ready.active?.synchronization?.authorityState,
                    'AUTHORIZED'
                );
                assert.equal(
                    ready.active?.synchronization?.authorityUserId,
                    f.users[3]
                );
                assert.equal(
                    ready.active?.synchronization?.oldestPendingAt,
                    null
                );
                assert(
                    ready.active?.synchronization?.lastPublishedAt instanceof
                        Date
                );
                const current = await f.manager.rag.indexing.documents({
                    collectionId: entry.collection.id,
                    query: '',
                    limit: 20,
                    offset: 0,
                });
                assert(
                    current.items.every(
                        (row) =>
                            row.freshness === 'CURRENT' &&
                            row.retryTaskId === null &&
                            row.pendingSince === null
                    )
                );
                assert.equal(
                    await prisma.ragAuditLog.count({
                        where: {
                            organizationId: f.org,
                            targetId: entry.collection.id,
                            actorId: f.users[3],
                            action: 'collection.index.synchronization.adopted',
                        },
                    }),
                    1
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'group grants, current custom role permissions and removed controller membership are checked before new embedding cost',
        async () => {
            const fixture = await createSyncFixture(
                'Current group and role authority'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Current group controller',
                    controller: 'manager',
                });
                const group = await f.owner.rag.groups.create({
                    name: 'Current synchronization controllers',
                });
                await f.owner.rag.groups.addMember({
                    id: group.id,
                    memberId: f.managerMember,
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'group', id: group.id },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.collections.removeGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                });
                await f.owner.rag.groups.removeMember({
                    id: group.id,
                    memberId: f.managerMember,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nGroup revoked v2.`
                );
                let calls = fixture.state.embedCalls;
                await scanSync(fixture, [entry.generationId], 2);
                let failed = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(failed.errorCode, 'ACCESS_REVOKED');
                assert.equal(fixture.state.embedCalls, calls);
                await f.owner.rag.groups.addMember({
                    id: group.id,
                    memberId: f.managerMember,
                });
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: failed.id,
                });
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );

                await f.owner.post('organization/update-role', {
                    organizationId: f.org,
                    roleName: fixture.managerRole,
                    data: {
                        permission: {
                            dashboard: ['read'],
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                        },
                    },
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nRole revoked v3.`
                );
                calls = fixture.state.embedCalls;
                await scanSync(fixture, [entry.generationId], 2);
                failed = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(failed.errorCode, 'ACCESS_REVOKED');
                assert.equal(fixture.state.embedCalls, calls);
                await f.owner.post('organization/update-role', {
                    organizationId: f.org,
                    roleName: fixture.managerRole,
                    data: {
                        permission: {
                            dashboard: ['read'],
                            ragCollection: ['read', 'manageDocuments'],
                            ragLibrary: ['read'],
                        },
                    },
                });
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: failed.id,
                });
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    3
                );

                await f.owner.post('organization/remove-member', {
                    organizationId: f.org,
                    memberIdOrEmail: f.managerMember,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nRemoved controller v4.`
                );
                calls = fixture.state.embedCalls;
                await scanSync(fixture, [entry.generationId], 2);
                assert.equal(
                    (
                        await currentSyncTask(
                            entry.generationId,
                            entry.documentId
                        )
                    ).errorCode,
                    'ACCESS_REVOKED'
                );
                assert.equal(fixture.state.embedCalls, calls);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    3
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'valid scoped keys, foreign identifiers and obsolete detached tasks cannot adopt or resurrect content, while accepted cleanup survives controller removal',
        async () => {
            const fixture = await createSyncFixture(
                'Session isolation and deletion'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'No synchronization resurrection',
                });
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Scoped synchronization key',
                        permissions: {
                            ragCollection: ['read', 'manageDocuments'],
                            ragLibrary: ['read'],
                        },
                        collectionScopes: [
                            {
                                collectionId: entry.collection.id,
                                read: true,
                                manageDocuments: true,
                            },
                        ],
                    });
                const api = rpc(() => ({ 'x-api-key': key.key })).admin.rag
                    .indexing;
                await assertSyncDenied(
                    api.adoptSynchronization({
                        collectionId: entry.collection.id,
                        generationId: entry.generationId,
                        expectedAuthorityUserId: f.users[0]!,
                    })
                );
                await assertSyncDenied(
                    f.other.rag.indexing.adoptSynchronization({
                        collectionId: entry.collection.id,
                        generationId: entry.generationId,
                        expectedAuthorityUserId: f.users[0]!,
                    })
                );
                await assertSyncDenied(
                    f.reader.rag.indexing.adoptSynchronization({
                        collectionId: entry.collection.id,
                        generationId: entry.generationId,
                        expectedAuthorityUserId: f.users[0]!,
                    })
                );
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.manager.rag.indexing.adoptSynchronization({
                    collectionId: entry.collection.id,
                    generationId: entry.generationId,
                    expectedAuthorityUserId: f.users[0]!,
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncReadGrant,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nDetached blocked v2.`
                );
                await scanSync(fixture, [entry.generationId], 2);
                const failed = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.documents.setCollection({
                    id: entry.documentId,
                    collectionId: entry.collection.id,
                    attached: false,
                });
                await assertSyncDenied(
                    f.manager.rag.indexing.retry({
                        collectionId: entry.collection.id,
                        taskId: failed.id,
                    }),
                    ['CONFLICT']
                );
                const empty = await f.manager.rag.indexing.adoptSynchronization(
                    {
                        collectionId: entry.collection.id,
                        generationId: entry.generationId,
                        expectedAuthorityUserId: f.users[3]!,
                    }
                );
                assert.equal(
                    empty.reboundPendingTasks + empty.interruptedTasks,
                    0
                );
                assert.equal(
                    await prisma.collectionDocument.count({
                        where: {
                            collectionId: entry.collection.id,
                            documentId: entry.documentId,
                        },
                    }),
                    0
                );
                await f.owner.rag.collections.delete({
                    id: entry.collection.id,
                    expectedRevision: 1,
                });
                await f.owner.post('organization/remove-member', {
                    organizationId: f.org,
                    memberIdOrEmail: f.managerMember,
                });
                // Controlled retention clock only: accepted real cleanup performs all deletion/accounting after controller removal.
                for (let pass = 0; pass < 12; pass++) {
                    await prisma.documentSourceHold.updateMany({
                        where: {
                            organizationId: f.org,
                            indexedDocument: {
                                generationId: entry.generationId,
                            },
                            state: 'RETIRED',
                        },
                        data: { retainUntil: new Date(0) },
                    });
                    await prisma.indexTask.updateMany({
                        where: {
                            generationId: entry.generationId,
                            kind: {
                                in: [
                                    'CLEAN_PUBLICATION',
                                    'CLEAN_GENERATION',
                                    'REMOVE_DOCUMENT',
                                ],
                            },
                            status: 'PENDING',
                        },
                        data: { availableAt: new Date(0) },
                    });
                    await fixture.scan(1);
                    if (
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: entry.generationId },
                            })
                        ).status === 'CLEANED'
                    )
                        break;
                }
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).status,
                    'CLEANED'
                );
                await assertSyncDenied(
                    f.owner.rag.indexing.adoptSynchronization({
                        collectionId: entry.collection.id,
                        generationId: entry.generationId,
                        expectedAuthorityUserId: f.users[3]!,
                    })
                );
                assert.equal(
                    await prisma.chunk.count({
                        where: { generationId: entry.generationId },
                    }),
                    0
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'a nonsemantic response arriving after management revocation cannot publish a replacement or remove the old readable source',
        async () => {
            const fixture = await createSyncFixture(
                'Nonsemantic late authority'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Read remains after management revoke',
                });
                const query = {
                    collectionId: entry.collection.id,
                    query: 'forest',
                    strategy: 'HYBRID' as const,
                    topK: 5,
                    filters: {},
                };
                const old = await f.owner.rag.indexing.search(query);
                const receipt = old.results[0]!.source.receipt;
                const previous = await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    1
                );
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nPaused replacement v2.`
                );
                const latch = semanticLatch();
                fixture.state.beforeEmbedding = async () => {
                    delete fixture.state.beforeEmbedding;
                    await latch.block();
                };
                const running = scanSync(fixture, [entry.generationId], 1);
                try {
                    await latch.arrived();
                    await f.owner.rag.collections.setGrant({
                        id: entry.collection.id,
                        target: { type: 'member', id: f.ownerMember },
                        permissions: syncReadGrant,
                    });
                } finally {
                    latch.release();
                    delete fixture.state.beforeEmbedding;
                    await running;
                }
                const task = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(task.status, 'FAILED');
                assert.equal(task.errorCode, 'ACCESS_REVOKED');
                assert.equal(
                    (
                        await assertSyncVersion(
                            entry.generationId,
                            entry.documentId,
                            1
                        )
                    ).id,
                    previous.id
                );
                const result = await f.owner.rag.indexing.search(query);
                assert(
                    result.results.every(
                        (row) => row.version === 1 && row.parentContext
                    )
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: entry.collection.id,
                            receipt,
                        })
                    ).text(),
                    parentText
                );
            } finally {
                await fixture.close();
            }
        }
    );
}
