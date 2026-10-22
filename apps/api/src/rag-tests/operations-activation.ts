import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import {
    createOperationsFixture,
    operationCounts,
} from './operations-fixtures';
import { semanticLatch } from './semantic-fixtures';
import {
    assertSyncVersion,
    currentSyncTask,
    scanSync,
    startSyncCollection,
    syncManageGrant,
    waitSyncActive,
} from './sync-authority-fixtures';

/** A real blocked activation establishes a published-but-unserved candidate without a fabricated pointer or status. */
async function waitForOperationsActivation(pool: Pool, blocker: number) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
        const row = await pool.query<{ pid: number }>(
            'SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type=$1 AND $2=ANY(pg_blocking_pids(pid)) AND query LIKE $3 LIMIT 1',
            ['Lock', blocker, '%Collection%']
        );
        if (row.rowCount) return;
        await delay(10);
    }
    assert.fail(
        'The real operations fixture activation did not reach its collection fence.'
    );
}

/** A PUBLISHED first-build candidate's failed activation anchor is still current operational work until a guarded retry activates it. */
export async function operationsActivationTests(t: TestContext) {
    await t.test(
        'operations retain a failed activation anchor after all children publish and clear it only after actual authorized recovery',
        async () => {
            const fixture = await createOperationsFixture(
                'Published first-build anchor'
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
                    name: 'Operations activation anchor',
                    scan: false,
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncManageGrant,
                });
                await scanSync(fixture, [entry.generationId], 1);
                const lock = await pool.connect();
                const latch = semanticLatch();
                fixture.state.beforeEmbedding = async () => {
                    delete fixture.state.beforeEmbedding;
                    await latch.block();
                };
                const running = (async () => {
                    for (let pass = 0; pass < 40; pass++) {
                        await scanSync(fixture, [entry.generationId], 1);
                        if (
                            (
                                await currentSyncTask(
                                    entry.generationId,
                                    entry.documentId
                                )
                            ).status === 'FAILED' ||
                            (
                                await prisma.collection.findUniqueOrThrow({
                                    where: { id: entry.collection.id },
                                })
                            ).activeGenerationId
                        )
                            return;
                    }
                    assert.fail(
                        'The owned activation was not considered within bounded real scans.'
                    );
                })();
                try {
                    await latch.arrived();
                    await lock.query('BEGIN');
                    const blocker = (
                        await lock.query<{ pid: number }>(
                            'SELECT pg_backend_pid() AS pid'
                        )
                    ).rows[0]!.pid;
                    // Prisma cannot express this read-only barrier. NO KEY UPDATE
                    // permits descendant publication while blocking activation's write.
                    await lock.query(
                        'SELECT id FROM "Collection" WHERE id=$1 FOR NO KEY UPDATE',
                        [entry.collection.id]
                    );
                    latch.release();
                    await waitForOperationsActivation(pool, blocker);
                    await assertSyncVersion(
                        entry.generationId,
                        entry.documentId,
                        1
                    );
                    const before = await f.owner.rag.operations.overview({
                        category: 'INDEXING',
                        state: 'FAILED',
                    });
                    assert.equal(operationCounts(before, 'INDEXING').failed, 0);
                    assert.equal(before.visibleTotal, 0);
                    await f.owner.rag.collections.setGrant({
                        id: entry.collection.id,
                        target: { type: 'member', id: f.ownerMember },
                        permissions: {
                            read: true,
                            manageDocuments: false,
                            administer: true,
                        },
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
                assert.equal(anchor.status, 'FAILED');
                assert.equal(anchor.stage, 'ACTIVATION');
                assert.equal(anchor.errorCode, 'ACCESS_REVOKED');
                const published = await assertSyncVersion(
                    entry.generationId,
                    entry.documentId,
                    1
                );
                assert.equal(
                    (
                        await prisma.collection.findUniqueOrThrow({
                            where: { id: entry.collection.id },
                        })
                    ).activeGenerationId,
                    null
                );
                const operations = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    state: 'FAILED',
                });
                assert.equal(operationCounts(operations, 'INDEXING').failed, 1);
                assert.equal(operations.visibleTotal, 1);
                assert.equal(operations.items[0]?.id, anchor.id);
                assert.equal(operations.items[0]?.kind, 'INDEX_DOCUMENT');
                assert.equal(
                    operations.items[0]?.target.id,
                    entry.collection.id
                );
                assert.equal(operations.items[0]?.errorCode, 'ACCESS_REVOKED');
                assert.equal(
                    (
                        await f.manager.rag.indexing.documents({
                            collectionId: entry.collection.id,
                            query: '',
                            limit: 10,
                            offset: 0,
                        })
                    ).items[0]?.freshness,
                    'BLOCKED'
                );
                await f.manager.rag.indexing.retry({
                    collectionId: entry.collection.id,
                    taskId: anchor.id,
                });
                await waitSyncActive(fixture, entry.generationId);
                assert.equal(
                    (
                        await assertSyncVersion(
                            entry.generationId,
                            entry.documentId,
                            1
                        )
                    ).id,
                    published.id
                );
                const recovered = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                });
                assert.equal(operationCounts(recovered, 'INDEXING').total, 0);
                assert.equal(recovered.visibleTotal, 0);
            } finally {
                await pool.end();
                await fixture.close();
            }
        }
    );
}
