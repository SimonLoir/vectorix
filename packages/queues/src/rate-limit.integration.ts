import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
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

after(() => closeRateLimitStore());

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
        await sleep(1100);
        assert.equal((await consumeRateLimit(key, 1, 5)).allowed, true);
        assert.deepEqual(warnings, []);
    } finally {
        console.warn = warn;
    }
});
