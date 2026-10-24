import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// Point at a closed loopback port so this unit test exercises only the fallback.
process.env.REDIS_URL = 'redis://127.0.0.1:1/15';
const { closeRateLimitStore, consumeRateLimit } = await import('./rate-limit');

after(() => closeRateLimitStore());

void test('an unavailable Redis degrades to a bounded per-process fixed window', async () => {
    const warn = console.warn;
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    try {
        const key = `unit:${Date.now()}`;
        const first = await consumeRateLimit(key, 60, 2);
        const second = await consumeRateLimit(key, 60, 2);
        const third = await consumeRateLimit(key, 60, 2);
        assert.deepEqual(first, { allowed: true, retryAfterSeconds: 0 });
        assert.deepEqual(second, { allowed: true, retryAfterSeconds: 0 });
        assert.equal(third.allowed, false);
        assert.ok(
            third.retryAfterSeconds >= 59 && third.retryAfterSeconds <= 60
        );
        assert.equal(
            (await consumeRateLimit(`${key}:other`, 60, 2)).allowed,
            true
        );
        assert.deepEqual(warnings, [
            '[rate-limit] Redis is unavailable; using per-process limits until it recovers.',
        ]);
    } finally {
        console.warn = warn;
    }
});
