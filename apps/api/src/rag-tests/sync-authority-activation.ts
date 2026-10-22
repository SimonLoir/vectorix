import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { semanticLatch } from './semantic-fixtures';
import {
    assertSyncVersion,
    createSyncFixture,
    currentSyncTask,
    scanSync,
    startSyncCollection,
    syncManageGrant,
    syncReadGrant,
    waitSyncActive,
} from './sync-authority-fixtures';

/** Observe the real activation query after publication; timing alone cannot prove the authority check occurs after the grant edit. */
async function waitForActivation(pool: Pool, blocker: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const waiting = await pool.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND $2=ANY(pg_blocking_pids(pid)) AND query LIKE $3 LIMIT 1',
            ['Lock', blocker, '%Collection%']
        );
        if (waiting.rowCount) return;
        await delay(10);
    }
    assert.fail(
        'The actual initial activation did not reach its owned collection row barrier.'
    );
}

/** Initial retries preserve supported authority transfer; activation independently checks that newly accepted controller's current grants. */
export async function syncAuthorityActivationTests(t: TestContext) {
    await t.test(
        'initial retry transfers and fences controller work, while activation rejects that controller after publication-time management revocation',
        async () => {
            const fixture = await createSyncFixture(
                'First activation controller'
            );
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: 3,
            });
            try {
                assert(
                    new URL(process.env.DATABASE_URL!).pathname.endsWith(
                        '_test'
                    )
                );
                const entry = await startSyncCollection(fixture, {
                    name: 'Initial retry and activation authority',
                    scan: false,
                });
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
                await scanSync(fixture, [entry.generationId], 1);
                const provision = await prisma.indexTask.findFirstOrThrow({
                    where: {
                        generationId: entry.generationId,
                        kind: 'PROVISION',
                    },
                });
                assert.equal(provision.status, 'FAILED');
                assert.equal(provision.errorCode, 'ACCESS_REVOKED');
                const originalIndex = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(originalIndex.status, 'PENDING');
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: provision.id,
                });
                const transferred = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(transferred.requestedBy, f.users[3]);
                assert.equal(
                    transferred.leaseEpoch,
                    originalIndex.leaseEpoch + 1n
                );
                assert.equal(transferred.attempts, originalIndex.attempts);
                assert.equal(
                    transferred.indexedDocumentId,
                    originalIndex.indexedDocumentId
                );
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).authorityUserId,
                    f.users[3]
                );
                await scanSync(fixture, [entry.generationId], 1);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).status,
                    'BUILDING'
                );

                const latch = semanticLatch();
                fixture.state.beforeEmbedding = async () => {
                    delete fixture.state.beforeEmbedding;
                    await latch.block();
                };
                // The activation scan rotates at most ten live generations. Continue real scans
                // until this owned generation's activation runs; no timestamps/statuses are forged.
                const running = (async () => {
                    for (let pass = 0; pass < 40; pass++) {
                        await scanSync(fixture, [entry.generationId], 1);
                        const task = await currentSyncTask(
                            entry.generationId,
                            entry.documentId
                        );
                        if (
                            task.status === 'FAILED' ||
                            (
                                await prisma.collection.findUniqueOrThrow({
                                    where: { id: entry.collection.id },
                                })
                            ).activeGenerationId
                        )
                            return;
                    }
                    assert.fail(
                        'The owned first generation was never considered for activation.'
                    );
                })();
                const lock = await pool.connect();
                try {
                    await latch.arrived();
                    await lock.query('BEGIN');
                    const blocker = (
                        await lock.query<{ pid: number }>(
                            'SELECT pg_backend_pid() AS pid'
                        )
                    ).rows[0]!.pid;
                    // NO KEY UPDATE permits normal descendant FK KEY SHARE and publication,
                    // but blocks activation's collection UPDATE. Prisma cannot express this barrier.
                    await lock.query(
                        'SELECT id FROM "Collection" WHERE id=$1 FOR NO KEY UPDATE',
                        [entry.collection.id]
                    );
                    latch.release();
                    await waitForActivation(pool, blocker);
                    const publication = await assertSyncVersion(
                        entry.generationId,
                        entry.documentId,
                        1
                    );
                    assert.equal(publication.id, transferred.indexedDocumentId);
                    const before = await f.manager.rag.indexing.status({
                        collectionId: entry.collection.id,
                    });
                    assert.equal(before.active, null);
                    const synchronization = before.generations.find(
                        (row) => row.id === entry.generationId
                    )?.synchronization;
                    assert.equal(synchronization?.authorityState, 'AUTHORIZED');
                    assert.equal(synchronization.pendingDocuments, 1);
                    assert.equal(synchronization.blockedTasks, 0);
                    assert(synchronization.oldestPendingAt instanceof Date);
                    assert(synchronization.lastPublishedAt instanceof Date);
                    const document = (
                        await f.manager.rag.indexing.documents({
                            collectionId: entry.collection.id,
                            query: '',
                            limit: 10,
                            offset: 0,
                        })
                    ).items.find((row) => row.documentId === entry.documentId);
                    assert(document);
                    assert.equal(document.freshness, 'PENDING');
                    assert(document.indexedAt instanceof Date);
                    assert(document.pendingSince instanceof Date);
                    await f.owner.rag.collections.setGrant({
                        id: entry.collection.id,
                        target: { type: 'member', id: f.managerMember },
                        permissions: syncReadGrant,
                    });
                } finally {
                    latch.release();
                    delete fixture.state.beforeEmbedding;
                    await lock.query('ROLLBACK');
                    lock.release();
                    await running;
                }
                const anchor = await currentSyncTask(
                    entry.generationId,
                    entry.documentId
                );
                assert.equal(anchor.requestedBy, f.users[3]);
                assert.equal(anchor.status, 'FAILED');
                assert.equal(anchor.stage, 'ACTIVATION');
                assert.equal(anchor.errorCode, 'ACCESS_REVOKED');
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).status,
                    'BUILDING'
                );
                assert.equal(
                    (
                        await prisma.collection.findUniqueOrThrow({
                            where: { id: entry.collection.id },
                        })
                    ).activeGenerationId,
                    null
                );
                const blocked = (
                    await f.owner.rag.indexing.documents({
                        collectionId: entry.collection.id,
                        query: '',
                        limit: 10,
                        offset: 0,
                    })
                ).items.find((row) => row.documentId === entry.documentId);
                assert.equal(blocked?.freshness, 'BLOCKED');
                assert.equal(blocked.retryTaskId, null);
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: syncManageGrant,
                });
                await f.owner.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: anchor.id,
                });
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: entry.generationId },
                        })
                    ).authorityUserId,
                    f.users[0]
                );
                await waitSyncActive(fixture, entry.generationId);
                const after = await f.owner.rag.indexing.status({
                    collectionId: entry.collection.id,
                });
                assert.equal(after.active?.id, entry.generationId);
                assert.equal(
                    after.active.synchronization?.authorityUserId,
                    f.users[0]
                );
                assert.equal(after.active.synchronization?.pendingDocuments, 0);
                assert.equal(after.active.synchronization?.blockedTasks, 0);
                assert.equal(
                    (
                        await assertSyncVersion(
                            entry.generationId,
                            entry.documentId,
                            1
                        )
                    ).id,
                    transferred.indexedDocumentId
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.documents({
                            collectionId: entry.collection.id,
                            query: '',
                            limit: 10,
                            offset: 0,
                        })
                    ).items[0]?.freshness,
                    'CURRENT'
                );
            } finally {
                await pool.end();
                await fixture.close();
            }
        }
    );
}
