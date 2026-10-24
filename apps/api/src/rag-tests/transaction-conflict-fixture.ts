import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { prisma } from '@repo/db';
import { fixture } from './fixtures';

/**
 * Force two native creations to overlap after their quota reads, without changing data.
 * The existing organization KEY SHARE trigger waits on this exact owned row lock.
 * Raw SQL is necessary for row locking and bounded PostgreSQL lock observation.
 */
export async function raceLastCollectionSlot<T>(
    create: (index: number) => Promise<T>
): Promise<PromiseSettledResult<T>[]> {
    assert.ok(fixture.org);
    const identity = await prisma.$queryRaw<{ name: string }[]>`
        SELECT current_database() AS name
    `;
    assert.equal(identity.length, 1);
    assert.ok(identity[0]!.name.endsWith('_test'));
    const locked = Promise.withResolvers<number>();
    const release = Promise.withResolvers<void>();
    const controller = prisma.$transaction(
        async (tx) => {
            const rows = await tx.$queryRaw<{ id: string; pid: number }[]>`
            SELECT id, pg_backend_pid() AS pid
            FROM public.organization
            WHERE id = ${fixture.org}
            FOR UPDATE
        `;
            assert.equal(rows.length, 1);
            assert.equal(rows[0]!.id, fixture.org);
            locked.resolve(rows[0]!.pid);
            await release.promise;
        },
        { maxWait: 2000, timeout: 8000 }
    );
    // Drain an early controller failure even before the two HTTP calls exist.
    void controller.catch((error: unknown) => locked.reject(error));
    let pending: Promise<PromiseSettledResult<T>[]> | undefined;
    let failure: unknown;
    try {
        const pid = await locked.promise;
        pending = Promise.allSettled([0, 1].map(create));
        const deadline = performance.now() + 5000;
        let waiting = 0;
        while (performance.now() < deadline) {
            const rows = await prisma.$queryRaw<{ count: number }[]>`
                SELECT count(*)::integer AS count
                FROM pg_catalog.pg_stat_activity
                WHERE datname = current_database()
                  AND ${pid} = ANY(pg_catalog.pg_blocking_pids(pid))
            `;
            waiting = rows[0]!.count;
            assert.ok(
                waiting <= 2,
                'Only the two owned creations may wait on the fixture lock.'
            );
            if (waiting === 2) break;
            await delay(10);
        }
        assert.equal(
            waiting,
            2,
            'Both native requests must reach the organization write fence.'
        );
    } catch (error) {
        failure = error;
    } finally {
        release.resolve();
        try {
            await controller;
        } catch (error) {
            failure ??= error;
        }
    }
    const results = pending ? await pending : undefined;
    if (failure) throw failure;
    assert.ok(results);
    return results;
}
