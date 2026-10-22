import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { parentText } from './parent-fixtures';
import { semanticLatch, semanticText } from './semantic-fixtures';
import {
    assertSyncVersion,
    createSyncFixture,
    currentSyncTask,
    replaceSyncSource,
    scanSync,
    startSyncCollection,
    syncManageGrant,
} from './sync-authority-fixtures';

/** Wait for actual row-lock contention, including a waiter queued behind another waiter. */
async function waitForCollectionWaiters(pool: Pool, count: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        const result = await pool.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%Collection%' AND cardinality(pg_blocking_pids(pid))>0"
        );
        if (Number(result.rows[0]?.count) >= count) return;
        await delay(10);
    }
    assert.fail(
        'Owned synchronization operations did not reach their actual collection fences.'
    );
}

/** A rollback-only row barrier controls ordering without changing source, lease or publication data. */
async function collectionBarrier<T>(
    collectionId: string,
    count: number,
    operations: () => Promise<T>[]
) {
    assert(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'));
    const pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: 3,
    });
    const lock = await pool.connect();
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    try {
        try {
            await lock.query('BEGIN');
            await lock.query(
                'SELECT id FROM "Collection" WHERE id=$1 FOR UPDATE',
                [collectionId]
            );
            pending = Promise.allSettled(operations());
            await waitForCollectionWaiters(pool, count);
        } finally {
            await lock.query('ROLLBACK');
            lock.release();
        }
        assert(pending);
        return await pending;
    } finally {
        await pending;
        await pool.end();
    }
}

/** Real paused native responses and public adoption calls prove epoch fencing even when the user identity returns to A. */
export async function syncAuthorityRaceTests(t: TestContext) {
    await t.test(
        'parent-semantic A to B to A adoption records late native success once without accepting its stale checkpoint',
        async () => {
            const fixture = await createSyncFixture('Semantic ABA epoch fence');
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Semantic ABA controller',
                    strategy: 'SEMANTIC',
                    text: semanticText(64),
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${semanticText(64)}\nNouvelle forêt ABA.`
                );
                const latch = semanticLatch();
                fixture.state.beforeEmbedding = async () => {
                    delete fixture.state.beforeEmbedding;
                    await latch.block();
                };
                const running = scanSync(fixture, [entry.generationId], 1);
                let workId = '';
                let completedUnits = -1;
                let originalEpoch = -1n;
                try {
                    await latch.arrived();
                    const task = await currentSyncTask(
                        entry.generationId,
                        entry.documentId
                    );
                    assert.equal(task.status, 'PROCESSING');
                    assert(task.indexedDocumentId);
                    originalEpoch = task.leaseEpoch;
                    const plan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        });
                    const work =
                        await prisma.embeddingWorkAttempt.findFirstOrThrow({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                                state: 'IN_FLIGHT',
                            },
                        });
                    workId = work.id;
                    completedUnits = plan.completedUnits;
                    const beforeUsage =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    const first =
                        await f.manager.rag.indexing.adoptSynchronization({
                            collectionId: entry.collection.id,
                            generationId: entry.generationId,
                            expectedAuthorityUserId: f.users[0]!,
                        });
                    assert.equal(first.interruptedTasks, 1);
                    const second =
                        await f.owner.rag.indexing.adoptSynchronization({
                            collectionId: entry.collection.id,
                            generationId: entry.generationId,
                            expectedAuthorityUserId: f.users[3]!,
                        });
                    assert.equal(second.reboundPendingTasks, 1);
                    const fenced = await currentSyncTask(
                        entry.generationId,
                        entry.documentId
                    );
                    assert.equal(fenced.leaseEpoch, originalEpoch + 2n);
                    assert.equal(fenced.status, 'PENDING');
                    assert.equal(fenced.requestedBy, task.requestedBy);
                    assert.equal(fenced.leaseToken, null);
                    assert.equal(fenced.leasedUntil, null);
                    assert.equal(fenced.attempts, task.attempts);
                    assert.equal(fenced.continuations, task.continuations);
                    const preserved =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        });
                    assert.ok(
                        isDeepStrictEqual(preserved, plan),
                        'Adoption must preserve the exact semantic prefix, payload and admitted reserves.'
                    );
                    const adoptedUsage =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    for (const field of [
                        'reservedPlanBytes',
                        'reservedPreparedBytes',
                        'reservedBatches',
                        'dispatchedPreparedBytes',
                        'dispatchedBatches',
                        'observedSuccessfulRequests',
                    ] as const)
                        assert.equal(adoptedUsage[field], beforeUsage[field]);
                } finally {
                    latch.release();
                    delete fixture.state.beforeEmbedding;
                    await running;
                }
                const observed =
                    await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                        where: { id: workId },
                    });
                assert.equal(observed.state, 'SUCCEEDED');
                assert(observed.usageRecordedAt);
                const task = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(task.leaseEpoch, originalEpoch + 2n);
                assert.equal(task.status, 'PENDING');
                const plan = await prisma.semanticChunkPlan.findUniqueOrThrow({
                    where: { indexedDocumentId: task.indexedDocumentId! },
                });
                assert.equal(plan.completedUnits, completedUnits);
                assert.equal(
                    await prisma.chunk.count({
                        where: { indexedDocumentId: task.indexedDocumentId! },
                    }),
                    0
                );
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    1
                );
                await scanSync(fixture, [entry.generationId], 8);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
                const attempts = await prisma.embeddingWorkAttempt.findMany({
                    where: { indexedDocumentId: task.indexedDocumentId! },
                });
                assert.equal(
                    attempts.filter(
                        (row) => row.id === workId && row.usageRecordedAt
                    ).length,
                    1
                );
                assert(
                    attempts.length >= 4,
                    'The stale native work remains in lifetime history alongside the accepted replay.'
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'adoption and library source publication serialize to the adopted controller in either accepted order',
        async () => {
            const fixture = await createSyncFixture(
                'Publication admission race'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Concurrent event and adoption',
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                const outcomes = await collectionBarrier(
                    entry.collection.id,
                    2,
                    () => [
                        f.manager.rag.indexing
                            .adoptSynchronization({
                                collectionId: entry.collection.id,
                                generationId: entry.generationId,
                                expectedAuthorityUserId: f.users[0]!,
                            })
                            .then(() => {}),
                        replaceSyncSource(
                            fixture,
                            entry.documentId,
                            `${parentText}\nConcurrent accepted v2.`
                        ).then(() => {}),
                    ]
                );
                for (const outcome of outcomes)
                    if (outcome.status === 'rejected') throw outcome.reason;
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
                    f.users[3]
                );
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'duplicate compare-and-set adoption has one winner and self-adoption still fences runnable work without replaying history',
        async () => {
            const fixture = await createSyncFixture('Adoption compare-and-set');
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Concurrent same expected controller',
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await replaceSyncSource(
                    fixture,
                    entry.documentId,
                    `${parentText}\nCAS pending v2.`
                );
                const before = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                const input = {
                    collectionId: entry.collection.id,
                    generationId: entry.generationId,
                    expectedAuthorityUserId: f.users[0]!,
                };
                const outcomes = await collectionBarrier(
                    entry.collection.id,
                    2,
                    () => [
                        f.manager.rag.indexing.adoptSynchronization(input),
                        f.manager.rag.indexing.adoptSynchronization(input),
                    ]
                );
                assert.equal(
                    outcomes.filter((row) => row.status === 'fulfilled').length,
                    1
                );
                const denied = outcomes.find(
                    (row) => row.status === 'rejected'
                );
                assert(denied?.status === 'rejected');
                assert(
                    denied.reason &&
                        typeof denied.reason === 'object' &&
                        'code' in denied.reason
                );
                assert.equal(denied.reason.code, 'CONFLICT');
                assert.equal(
                    await prisma.ragAuditLog.count({
                        where: {
                            organizationId: f.org,
                            targetId: entry.collection.id,
                            action: 'collection.index.synchronization.adopted',
                        },
                    }),
                    1
                );
                const first = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(first.leaseEpoch, before.leaseEpoch + 1n);
                const self = await f.manager.rag.indexing.adoptSynchronization({
                    ...input,
                    expectedAuthorityUserId: f.users[3]!,
                });
                assert.equal(self.reboundPendingTasks, 1);
                assert.equal(self.interruptedTasks, 0);
                const second = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(second.leaseEpoch, before.leaseEpoch + 2n);
                assert.equal(second.attempts, before.attempts);
                assert.equal(second.completedChunks, before.completedChunks);
                assert.equal(second.continuations, before.continuations);
                await scanSync(fixture, [entry.generationId]);
                await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    2
                );
            } finally {
                await fixture.close();
            }
        }
    );
}
