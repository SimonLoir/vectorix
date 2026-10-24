import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { connection } from './index';
import { closeRateLimitStore, consumeRateLimit } from './rate-limit';

// Launched only by scripts/test-redis.sh against its owned, authenticated server.
const target = new URL(process.env.REDIS_URL ?? 'redis://invalid');
if (
    process.env.VECTORIX_REDIS_ISOLATED_TEST !== '1' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.pathname !== '/15'
) {
    throw new Error('Run Redis rate-limit tests through pnpm test:queues.');
}

const inspector = new Redis({
    ...connection,
    lazyConnect: true,
    retryStrategy: () => null,
});
inspector.on('error', () => {});
after(async () => {
    inspector.disconnect();
    await closeRateLimitStore();
});

/** Timers can wake slightly early; never claim a complete delay from one wake. */
async function waitAtLeast(milliseconds: number) {
    const until = performance.now() + milliseconds;
    for (let wake = 0; wake < 64; wake++) {
        const remaining = until - performance.now();
        if (remaining <= 0) return;
        await sleep(Math.ceil(remaining));
    }
    throw new Error('The isolated test clock did not advance.');
}

void test('concurrent consumers share one atomic Redis window that expires', async () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    try {
        const key = `integration:${process.pid}:${Date.now()}`;
        const decisions = await Promise.all(
            Array.from({ length: 20 }, () => consumeRateLimit(key, 1, 5))
        );
        assert.equal(decisions.filter(({ allowed }) => allowed).length, 5);
        for (const denied of decisions.filter(({ allowed }) => !allowed))
            assert.equal(denied.retryAfterSeconds, 1);
        await waitAtLeast(1100);
        assert.equal((await consumeRateLimit(key, 1, 5)).allowed, true);
        assert.deepEqual(warnings, []);
    } finally {
        console.warn = warn;
    }
});

void test('Redis refreshes allowed hits but rejected requests do not prolong native cooldown', async () => {
    await inspector.connect();
    const key = `rolling:${process.pid}:${Date.now()}`;
    const redisKey = `vectorix:rate-limit:v2:${key}`;
    assert.equal((await consumeRateLimit(key, 1, 2)).allowed, true);
    await waitAtLeast(650);
    const beforeSecond = await inspector.pttl(redisKey);
    assert.ok(
        beforeSecond > 0 && beforeSecond < 600,
        'The first window must still be active before its allowed refresh.'
    );
    assert.equal((await consumeRateLimit(key, 1, 2)).allowed, true);
    const afterSecond = await inspector.pttl(redisKey);
    assert.ok(
        afterSecond > beforeSecond + 300,
        'An allowed hit must refresh the native last-request deadline.'
    );
    await waitAtLeast(650);
    const beforeDenied = await inspector.pttl(redisKey);
    assert.ok(beforeDenied > 0 && beforeDenied < 600);
    assert.equal((await consumeRateLimit(key, 1, 2)).allowed, false);
    const afterDenied = await inspector.pttl(redisKey);
    assert.ok(
        afterDenied <= beforeDenied && afterDenied > 0,
        'A rejected hit must not prolong the cooldown.'
    );
    await waitAtLeast(afterDenied + 25);
    assert.equal((await consumeRateLimit(key, 1, 2)).allowed, true);
});
