import assert from 'node:assert/strict';
import test from 'node:test';
import { Worker, type Job } from 'bullmq';
import { closeQueues, connection, getQueues } from './index';

// This file is launched only by scripts/test-redis.sh against its owned server.
// A direct invocation must never touch an application's queues.
const mode = process.env.VECTORIX_REDIS_TEST_MODE;
const target = new URL(process.env.REDIS_URL ?? 'redis://invalid');
if (
    process.env.VECTORIX_REDIS_ISOLATED_TEST !== '1' ||
    !['encoded', 'fallback'].includes(mode ?? '') ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.pathname !== '/15'
) {
    throw new Error('Run Redis authentication tests through pnpm test:queues.');
}

/** Bound infrastructure regressions even when the native Redis client retries. */
async function bounded<T>(operation: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            operation,
            new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                    () => reject(new Error('Redis test operation timed out.')),
                    7000
                );
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** Register before enqueueing so even immediate local delivery is observed. */
function completed(worker: Worker, name: string): Promise<Job> {
    return new Promise((resolve) => {
        const listener = (job: Job) => {
            if (job.name !== name) return;
            worker.off('completed', listener);
            resolve(job);
        };
        worker.on('completed', listener);
    });
}

void test(`real Redis authenticates all queues and workers using ${mode} credentials`, async () => {
    const queues = getQueues();
    const workers: Worker[] = [];
    let connectionErrors = 0;
    try {
        for (const queue of Object.values(queues)) {
            queue.on('error', () => connectionErrors++);
            const worker = new Worker(
                queue.name,
                (job) => Promise.resolve({ marker: job.data.marker as string }),
                { connection, concurrency: 1 }
            );
            workers.push(worker);
            worker.on('error', () => connectionErrors++);
            await bounded(
                Promise.all([queue.waitUntilReady(), worker.waitUntilReady()])
            );

            const marker = `redis-${mode}-${queue.name}`;
            const ordinary = completed(worker, 'auth-roundtrip');
            await bounded(
                queue.add(
                    'auth-roundtrip',
                    { marker },
                    { removeOnComplete: 20 }
                )
            );
            const delivered = await bounded(ordinary);
            assert.deepEqual(delivered.returnvalue, { marker });

            const scheduled = completed(worker, 'auth-scheduled');
            await bounded(
                queue.upsertJobScheduler(
                    'auth-scheduler',
                    { every: 60_000 },
                    {
                        name: 'auth-scheduled',
                        data: { marker: `${marker}-scheduled` },
                        opts: { removeOnComplete: 20 },
                    }
                )
            );
            const scanned = await bounded(scheduled);
            assert.deepEqual(scanned.returnvalue, {
                marker: `${marker}-scheduled`,
            });
            await bounded(queue.removeJobScheduler('auth-scheduler'));
        }
        assert.equal(connectionErrors, 0);
    } finally {
        // Force native disconnects first: a broken auth configuration must not
        // leave retrying handles alive after the assertion fails.
        await Promise.allSettled(workers.map((worker) => worker.close(true)));
        await Promise.allSettled(
            Object.values(queues).map((queue) => queue.disconnect())
        );
        await closeQueues();
    }
});
