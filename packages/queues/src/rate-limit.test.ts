import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import {
    createLocalRateLimitStore,
    readRateLimitDecision,
} from './rate-limit-core';

process.env.REDIS_URL = 'redis://127.0.0.1:1/15';
const { closeRateLimitStore, consumeRateLimit } = await import('./rate-limit');
after(() => closeRateLimitStore());

void test('the local store refreshes only allowed hits and preserves native cooldown', () => {
    let now = 0;
    const store = createLocalRateLimitStore({ now: () => now });
    assert.equal(store.consume('same', 10_000, 3).allowed, true);
    now = 9000;
    assert.equal(store.consume('same', 10_000, 3).allowed, true);
    now = 9500;
    assert.equal(store.consume('same', 10_000, 3).allowed, true);
    now = 10_000;
    assert.deepEqual(store.consume('same', 10_000, 3), {
        allowed: false,
        retryAfterSeconds: 10,
    });
    now = 19_499;
    assert.equal(store.consume('same', 10_000, 3).allowed, false);
    now = 19_501;
    assert.equal(store.consume('same', 10_000, 3).allowed, true);
});

void test('saturation cannot reset active budgets and expired entries are reclaimable', () => {
    let now = 0;
    const store = createLocalRateLimitStore({ now: () => now, maxEntries: 3 });
    assert.equal(store.consume('protected', 60_000, 1).allowed, true);
    assert.equal(store.consume('short-a', 1000, 1).allowed, true);
    assert.equal(store.consume('short-b', 1000, 1).allowed, true);
    for (let index = 0; index < 100; index++) {
        assert.equal(
            store.consume(`pressure-${index}`, 60_000, 1).allowed,
            false
        );
        assert.equal(store.consume('protected', 60_000, 1).allowed, false);
    }
    now = 1001;
    assert.equal(store.consume('new', 60_000, 1).allowed, true);
    assert.equal(store.consume('protected', 60_000, 1).allowed, false);
});

void test('the production capacity is bounded without evicting exhausted keys', () => {
    const store = createLocalRateLimitStore({ now: () => 0 });
    for (let index = 0; index < 10_000; index++)
        assert.equal(store.consume(`key-${index}`, 60_000, 1).allowed, true);
    assert.equal(store.consume('overflow', 60_000, 1).allowed, false);
    assert.equal(store.consume('key-0', 60_000, 1).allowed, false);
    assert.equal(store.consume('key-9999', 60_000, 1).allowed, false);
});

void test('only owned numeric Redis result shapes are accepted', () => {
    assert.deepEqual(readRateLimitDecision([1, 1000]), {
        allowed: true,
        retryAfterSeconds: 0,
    });
    assert.deepEqual(readRateLimitDecision([0, 1]), {
        allowed: false,
        retryAfterSeconds: 1,
    });
    for (const invalid of [
        null,
        [],
        [2, 1000],
        [0, -1],
        [1, '1000'],
        [0, Number.NaN],
    ])
        assert.throws(() => readRateLimitDecision(invalid), {
            message: 'Rate-limit response is invalid.',
        });
});

void test('fixed windows expire from the first hit without refreshing on allowed or denied requests', () => {
    let now = 0;
    const store = createLocalRateLimitStore({ now: () => now });
    assert.equal(store.consume('same', 10_000, 3, 'FIXED').allowed, true);
    now = 9000;
    assert.equal(store.consume('same', 10_000, 3, 'FIXED').allowed, true);
    now = 9500;
    assert.equal(store.consume('same', 10_000, 3, 'FIXED').allowed, true);
    now = 9999;
    assert.deepEqual(store.consume('same', 10_000, 3, 'FIXED'), {
        allowed: false,
        retryAfterSeconds: 1,
    });
    now = 10_000;
    assert.equal(store.consume('same', 10_000, 3, 'FIXED').allowed, true);
});

void test('window policies remain isolated for the same logical key and share one bounded fallback capacity', () => {
    let now = 0;
    const store = createLocalRateLimitStore({ now: () => now, maxEntries: 2 });
    assert.equal(store.consume('same', 10_000, 2).allowed, true);
    assert.equal(store.consume('same', 10_000, 2, 'FIXED').allowed, true);
    now = 9000;
    assert.equal(store.consume('same', 10_000, 2).allowed, true);
    assert.equal(store.consume('same', 10_000, 2, 'FIXED').allowed, true);
    assert.equal(store.consume('overflow', 10_000, 2).allowed, false);
    now = 10_000;
    assert.equal(store.consume('same', 10_000, 2).allowed, false);
    assert.equal(store.consume('same', 10_000, 2, 'FIXED').allowed, true);
    now = 19_000;
    assert.equal(store.consume('same', 10_000, 2).allowed, true);
    assert.equal(store.consume('same', 10_000, 2, 'FIXED').allowed, true);
});

void test('unavailable Redis emits one fixed warning and no library error or stack', async () => {
    const warn = console.warn;
    const error = console.error;
    const warnings: unknown[][] = [];
    const errors: unknown[][] = [];
    console.warn = (...values: unknown[]) => {
        warnings.push(values);
    };
    console.error = (...values: unknown[]) => {
        errors.push(values);
    };
    try {
        const key = 'unit-fallback';
        assert.equal((await consumeRateLimit(key, 60, 2)).allowed, true);
        assert.equal((await consumeRateLimit(key, 60, 2)).allowed, true);
        const denied = await consumeRateLimit(key, 60, 2);
        assert.equal(denied.allowed, false);
        assert.ok(
            denied.retryAfterSeconds >= 59 && denied.retryAfterSeconds <= 60
        );
        assert.equal((await consumeRateLimit('separate', 60, 2)).allowed, true);
        assert.equal(
            (await consumeRateLimit(key, 60, 1, 'FIXED')).allowed,
            true
        );
        assert.equal(
            (await consumeRateLimit(key, 60, 1, 'FIXED')).allowed,
            false
        );
        await closeRateLimitStore();
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.deepEqual(errors, []);
        assert.deepEqual(warnings, [
            [
                '[rate-limit] Redis is unavailable; using bounded per-process limits until it recovers.',
            ],
        ]);
    } finally {
        console.warn = warn;
        console.error = error;
    }
});
