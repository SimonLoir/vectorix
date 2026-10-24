import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    createAuthRateLimitStorage,
    hashAuthRateLimitKey,
    authRateLimitOptions,
} from '../src/rate-limit';
import { createTwoFactorPlugin } from '../src/two-factor';

void test('canonical native rate keys become bounded opaque digests before storage', async () => {
    const raw = '198.51.100.9|/reset-password/PRIVATE_TOKEN_SENTINEL';
    const key = hashAuthRateLimitKey(raw);
    assert.match(key, /^auth:[a-f0-9]{64}$/u);
    assert.equal(key, hashAuthRateLimitKey(raw));
    assert.notEqual(key, hashAuthRateLimitKey(`${raw}-different`));
    assert.notEqual(
        key,
        hashAuthRateLimitKey(raw.replace('198.51.100.9', '198.51.100.10'))
    );
    assert.equal(key.includes('PRIVATE_TOKEN_SENTINEL'), false);
    assert.equal(key.includes('198.51.100.9'), false);
    const captured: unknown[] = [];
    const storage = createAuthRateLimitStorage((...args) => {
        captured.push(args);
        return Promise.resolve({ allowed: false, retryAfterSeconds: 7 });
    });
    assert.ok(storage.consume);
    assert.deepEqual(await storage.consume(raw, { window: 60, max: 6 }), {
        allowed: false,
        retryAfter: 7,
    });
    assert.deepEqual(captured, [[key, 60, 6]]);
});

void test('native atomic consume maps allowed requests to null retry without changing the selected window', async () => {
    let calls = 0;
    const storage = createAuthRateLimitStorage((key, window, max) => {
        calls++;
        assert.equal(key, hashAuthRateLimitKey('native-ip|/sign-in/email'));
        assert.equal(window, 10);
        assert.equal(max, 3);
        return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    });
    assert.deepEqual(
        await storage.consume('native-ip|/sign-in/email', {
            window: 10,
            max: 3,
        }),
        { allowed: true, retryAfter: null }
    );
    assert.equal(calls, 1);
});

void test('native atomic storage failure propagates without a permissive fallback or repeated consume', async () => {
    const failure = new Error('Controlled atomic storage refusal.');
    let calls = 0;
    const storage = createAuthRateLimitStorage(() => {
        calls++;
        return Promise.reject(failure);
    });
    await assert.rejects(
        storage.consume('native-ip|/two-factor/verify-totp', {
            window: 10,
            max: 3,
        }),
        (error: unknown) => error === failure
    );
    assert.equal(calls, 1);
});

void test('native second-factor rules are selected without custom verification overrides', () => {
    const plugin = createTwoFactorPlugin();
    const rules = plugin.rateLimit;
    assert.ok(rules);
    for (const path of [
        '/two-factor/verify-totp',
        '/two-factor/verify-otp',
        '/two-factor/verify-backup-code',
    ]) {
        assert.equal(
            Object.hasOwn(authRateLimitOptions.customRules, path),
            false
        );
        const rule = rules.find((candidate) => candidate.pathMatcher(path));
        assert.ok(rule);
        assert.equal(rule.window, 10);
        assert.equal(rule.max, 3);
    }
    assert.deepEqual(authRateLimitOptions.customRules['/reset-password'], {
        window: 300,
        max: 5,
    });
});
