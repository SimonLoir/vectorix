import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { createParentFixture, parentText, scanParent } from './parent-fixtures';

/** Observe an actual waiting Chunk query rather than assuming middleware captured the manager grant. */
async function waitForPreviewRead(pool: Pool, blocker: number) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        const waiting = await pool.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%Chunk%' LIMIT 1",
            [blocker]
        );
        if (waiting.rowCount) return;
        await delay(10);
    }
    assert.fail('The owned preview did not reach its locked Chunk read.');
}

/** A manager downgraded to a reader must not receive captured unpublished child/context rows or totals. */
export async function parentPreviewRaceTests(t: TestContext) {
    await t.test(
        'manager-only unpublished preview is rejected after manageDocuments is revoked while read remains',
        async () => {
            const fixture = await createParentFixture(
                'Preview downgrade race',
                true
            );
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: 2,
            });
            try {
                assert(
                    new URL(process.env.DATABASE_URL!).pathname.endsWith(
                        '_test'
                    )
                );
                const collection = await fixture.collection(
                    'Unpublished manager preview'
                );
                await fixture.upload(
                    parentText,
                    'unpublished-parent.txt',
                    collection.id
                );
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                fixture.state.rejectEmbeddings = true;
                await scanParent(fixture, started.generationId, 3);
                fixture.state.rejectEmbeddings = false;
                assert.equal(
                    (
                        await f.owner.rag.indexing.status({
                            collectionId: collection.id,
                        })
                    ).active,
                    null
                );
                assert(
                    (await prisma.chunk.count({
                        where: {
                            generationId: started.generationId,
                            kind: 'PARENT',
                        },
                    })) > 0
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.managerMember },
                    permissions: {
                        read: true,
                        manageDocuments: true,
                        administer: false,
                    },
                });
                const input = {
                    collectionId: collection.id,
                    generationId: started.generationId,
                    limit: 10,
                };
                const before = await f.manager.rag.indexing.chunks(input);
                assert(
                    before.total > 0 &&
                        before.items.some(
                            (row) => row.parentContext && !row.published
                        )
                );
                const lock = await pool.connect();
                let result: Promise<unknown> | undefined;
                try {
                    await lock.query('BEGIN');
                    const blocker = (
                        await lock.query<{ pid: number }>(
                            'SELECT pg_backend_pid() AS pid'
                        )
                    ).rows[0]!.pid;
                    // Prisma cannot express a table-lock barrier. The serial catalog runner
                    // owns this _test database; rollback releases it without changing data.
                    await lock.query(
                        'LOCK TABLE "Chunk" IN ACCESS EXCLUSIVE MODE'
                    );
                    result = f.manager.rag.indexing.chunks(input).then(
                        () => null,
                        (error: unknown) => error
                    );
                    await waitForPreviewRead(pool, blocker);
                    await f.owner.rag.collections.setGrant({
                        id: collection.id,
                        target: { type: 'member', id: f.managerMember },
                        permissions: {
                            read: true,
                            manageDocuments: false,
                            administer: false,
                        },
                    });
                } finally {
                    await lock.query('ROLLBACK');
                    lock.release();
                }
                const denied = await result;
                assert(
                    denied && typeof denied === 'object' && 'code' in denied
                );
                assert.equal(denied.code, 'FORBIDDEN');
                const current = await f.manager.rag.indexing.status({
                    collectionId: collection.id,
                });
                assert.equal(current.canRead, true);
                assert.equal(current.canManage, false);
                await assert.rejects(f.manager.rag.indexing.chunks(input));
            } finally {
                await pool.end();
                await fixture.close();
            }
        }
    );
}
