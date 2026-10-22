import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';

type Outcome<T> = { result: T } | { error: unknown };

/** Observe actual PostgreSQL contention, not an assumed timing delay. */
async function blockedBy(catalog: Pool, blocker: number) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
        const waiting = await catalog.query<{ pid: number }>(
            "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) LIMIT 1",
            [blocker]
        );
        if (waiting.rowCount) return;
        await delay(10);
    }
    assert.fail(
        'The public admission/discard request did not reach its expected database row lock.'
    );
}

/**
 * Hold the same collection-to-generation sequence as activation while the real
 * public operation holds the organization admission fence and waits for it.
 * Direct SQL keeps the controlled backend and deadlock detector in one session;
 * with an UPDATE of the organization key, this backend would deadlock in its
 * descendant KEY SHARE trigger. A short local detector makes that failure
 * observable instead of allowing the competing API transaction to mask it by retry.
 */
async function activationFence<T>(
    catalog: Pool,
    collectionId: string,
    generationId: string,
    operation: () => Promise<T>
): Promise<Outcome<T>> {
    const activation = await catalog.connect();
    let pending: Promise<Outcome<T>> | undefined;
    try {
        await activation.query('BEGIN');
        await activation.query("SET LOCAL deadlock_timeout='50ms'");
        const pid = (
            await activation.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid'
            )
        ).rows[0]!.pid;
        await activation.query(
            'UPDATE "Collection" SET "contentSequence"="contentSequence" WHERE id=$1',
            [collectionId]
        );
        pending = operation().then(
            (result) => ({ result }),
            (error: unknown) => ({ error })
        );
        await blockedBy(catalog, pid);
        await activation.query(
            'UPDATE "IndexGeneration" SET "updatedAt"=clock_timestamp() WHERE id=$1',
            [generationId]
        );
        await activation.query('COMMIT');
        return await pending;
    } finally {
        await activation.query('ROLLBACK').catch(() => {});
        activation.release();
        await pending;
    }
}

/** Real API locks remain compatible with activation and cannot reactivate a concurrently suspended organization. */
export async function rebuildLockTests(input: {
    collectionId: string;
    expectedRevision: number;
    activeGenerationId: string;
    requestId: string;
}) {
    assert(new URL(process.env.DATABASE_URL!).pathname.endsWith('_test'));
    const catalog = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const accepted = await activationFence(
            catalog,
            input.collectionId,
            input.activeGenerationId,
            () =>
                f.owner.rag.indexing.rebuild({
                    collectionId: input.collectionId,
                    expectedRevision: input.expectedRevision,
                    expectedActiveGenerationId: input.activeGenerationId,
                    requestId: input.requestId,
                })
        );
        if ('error' in accepted) throw accepted.error;
        const discarded = await activationFence(
            catalog,
            input.collectionId,
            input.activeGenerationId,
            () =>
                f.owner.rag.indexing.discard({
                    collectionId: input.collectionId,
                    generationId: input.activeGenerationId,
                })
        );
        assert(
            'error' in discarded &&
                discarded.error &&
                typeof discarded.error === 'object' &&
                'code' in discarded.error
        );
        assert.equal(discarded.error.code, 'CONFLICT');
        const suspension = await catalog.connect();
        let suspendedRequest: Promise<Outcome<{ success: true }>> | undefined;
        try {
            await suspension.query('BEGIN');
            const pid = (
                await suspension.query<{ pid: number }>(
                    'SELECT pg_backend_pid() AS pid'
                )
            ).rows[0]!.pid;
            await suspension.query(
                'UPDATE organization SET "isActive"=false WHERE id=$1',
                [f.org]
            );
            suspendedRequest = f.owner.rag.indexing
                .discard({
                    collectionId: input.collectionId,
                    generationId: accepted.result.generationId,
                })
                .then(
                    (result) => ({ result }),
                    (error: unknown) => ({ error })
                );
            await blockedBy(catalog, pid);
            await suspension.query('COMMIT');
            const denied = await suspendedRequest;
            assert(
                'error' in denied &&
                    denied.error &&
                    typeof denied.error === 'object' &&
                    'code' in denied.error
            );
            assert.equal(denied.error.code, 'FORBIDDEN');
            assert.equal(
                (
                    await prisma.organization.findUniqueOrThrow({
                        where: { id: f.org },
                    })
                ).isActive,
                false
            );
            assert.equal(
                (
                    await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: accepted.result.generationId },
                    })
                ).status,
                'PROVISIONING'
            );
        } finally {
            await suspension.query('ROLLBACK').catch(() => {});
            suspension.release();
            await suspendedRequest;
            // Restore this disposable fixture explicitly; the admission helper
            // must never perform this write on a suspended organization.
            await prisma.organization.update({
                where: { id: f.org },
                data: { isActive: true },
            });
        }
        assert.equal(
            (
                await prisma.collection.findUniqueOrThrow({
                    where: { id: input.collectionId },
                })
            ).activeGenerationId,
            input.activeGenerationId
        );
        return accepted.result;
    } finally {
        await catalog.end();
    }
}
