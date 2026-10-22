import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { fixture as f } from './fixtures';
import {
    createOperationsFixture,
    operationCounts,
} from './operations-fixtures';
import { startSyncCollection, syncReadGrant } from './sync-authority-fixtures';

/** Observe an actual blocked current-work query after authorization, not an assumed delay in request middleware. */
async function waitForOperationsRead(pool: Pool, blocker: number) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
        // Activity SQL text can be truncated before IndexTask in the UNION
        // summary. Observe the actual relation lock and exact blocker instead.
        const waiting = await pool.query<{ pid: number }>(
            'SELECT activity.pid FROM pg_stat_activity activity JOIN pg_locks waiting ON waiting.pid=activity.pid AND NOT waiting.granted WHERE activity.datname=current_database() AND activity.wait_event_type=$1 AND $2=ANY(pg_blocking_pids(activity.pid)) AND waiting.locktype=$3 AND waiting.relation=to_regclass($4) LIMIT 1',
            ['Lock', blocker, 'relation', 'public."IndexTask"']
        );
        if (waiting.rowCount) return;
        await delay(10);
    }
    assert.fail(
        'The owned operations snapshot did not reach its current-work table barrier.'
    );
}

/** A final current ACL read must reject a stale privileged page instead of returning names/IDs captured by RepeatableRead. */
export async function operationsRaceTests(t: TestContext) {
    await t.test(
        'an operations detail page captured before grant revocation cannot escape its final current metadata check',
        async () => {
            const fixture = await createOperationsFixture(
                'Final metadata read fence'
            );
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: 3,
            });
            let pending: Promise<unknown> | undefined;
            try {
                assert(
                    new URL(process.env.DATABASE_URL!).pathname.endsWith(
                        '_test'
                    )
                );
                const entry = await startSyncCollection(fixture, {
                    name: 'Operations grant revocation race',
                    scan: false,
                });
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: syncReadGrant,
                });
                const before = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                });
                assert.equal(before.visibleTotal, 2);
                const lock = await pool.connect();
                try {
                    await lock.query('BEGIN');
                    const blocker = (
                        await lock.query<{ pid: number }>(
                            'SELECT pg_backend_pid() AS pid'
                        )
                    ).rows[0]!.pid;
                    // SQL is necessary for a read barrier; rollback releases it and
                    // no task, source, lease, counter or completion is changed.
                    await lock.query(
                        'LOCK TABLE "IndexTask" IN ACCESS EXCLUSIVE MODE'
                    );
                    pending = f.manager.rag.operations
                        .overview({ category: 'INDEXING' })
                        .then(
                            () => null,
                            (error: unknown) => error
                        );
                    await waitForOperationsRead(pool, blocker);
                    await f.owner.rag.collections.removeGrant({
                        id: entry.collection.id,
                        target: { type: 'member', id: f.managerMember },
                    });
                } finally {
                    await lock.query('ROLLBACK');
                    lock.release();
                }
                const denied = await pending;
                assert(
                    denied && typeof denied === 'object' && 'code' in denied
                );
                assert.equal(denied.code, 'FORBIDDEN');
                const current = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                });
                assert.equal(operationCounts(current, 'INDEXING').total, 2);
                assert.equal(current.visibleTotal, 0);
                assert.deepEqual(current.items, []);
            } finally {
                await pending;
                await pool.end();
                await fixture.close();
            }
        }
    );
}
