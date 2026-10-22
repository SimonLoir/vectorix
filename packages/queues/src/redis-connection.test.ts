import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRedisConnection } from './redis-connection';

void test('Redis URL userinfo is decoded before passing connection options to BullMQ', () => {
    const username = 'queue@user:/%#é';
    const password = 'p@ss:/%#é';
    const connection = buildRedisConnection({
        REDIS_URL: `redis://${encodeURIComponent(username)}:${encodeURIComponent(password)}@redis.example.test:6380/2`,
        REDIS_PASSWORD: 'must-not-override-url',
    });
    assert.deepEqual(connection, {
        host: 'redis.example.test',
        port: 6380,
        username,
        password,
        db: 2,
        maxRetriesPerRequest: null,
    });
});

void test('percent encoding is decoded once and a literal plus is never treated as a space', () => {
    const connection = buildRedisConnection({
        REDIS_URL:
            'redis://user%252F+literal:a%252Fb+literal%25@redis.example.test',
    });
    assert.equal(connection.username, 'user%2F+literal');
    assert.equal(connection.password, 'a%2Fb+literal%');
});

void test('password-only and Unicode userinfo retain their exact authentication values', () => {
    const passwordOnly = buildRedisConnection({
        REDIS_URL: 'redis://:p%40ss%3Aw@redis.example.test',
    });
    assert.equal(passwordOnly.username, undefined);
    assert.equal(passwordOnly.password, 'p@ss:w');
    const unicode = buildRedisConnection({
        REDIS_URL: 'redis://utilisateur-é:mot-é🙂@redis.example.test',
    });
    assert.equal(unicode.username, 'utilisateur-é');
    assert.equal(unicode.password, 'mot-é🙂');
});

void test('missing and explicitly empty URL passwords preserve the raw standalone fallback', () => {
    const fallback = 'raw%40+password:/%#';
    for (const REDIS_URL of [
        'redis://redis.example.test',
        'redis://user@redis.example.test',
        'redis://user:@redis.example.test',
    ])
        assert.equal(
            buildRedisConnection({ REDIS_URL, REDIS_PASSWORD: fallback })
                .password,
            fallback
        );
    assert.equal(buildRedisConnection({ REDIS_PASSWORD: '' }).password, '');
    assert.equal(buildRedisConnection({}).password, undefined);
});

void test('default host, port, database, TLS and worker retry options remain compatible', () => {
    assert.deepEqual(buildRedisConnection({}), {
        host: 'localhost',
        port: 6379,
        username: undefined,
        password: undefined,
        db: 0,
        maxRetriesPerRequest: null,
    });
    assert.deepEqual(
        buildRedisConnection({
            REDIS_URL: 'rediss://user:password@redis.example.test:6381/4',
        }),
        {
            host: 'redis.example.test',
            port: 6381,
            username: 'user',
            password: 'password',
            db: 4,
            tls: {},
            maxRetriesPerRequest: null,
        }
    );
});

void test('malformed URL or userinfo fails without falling back or leaking parser diagnostics', () => {
    const sensitive = 'credential-sensitive-marker';
    for (const REDIS_URL of [
        '',
        `not-a-url-${sensitive}`,
        `redis://user:${sensitive}@redis.example.test:invalid`,
        `redis://user:${sensitive}%@redis.example.test`,
        `redis://user%2:${sensitive}@redis.example.test`,
        `redis://user:${sensitive}%FF@redis.example.test`,
    ]) {
        assert.throws(
            () =>
                buildRedisConnection({
                    REDIS_URL,
                    REDIS_PASSWORD: 'must-not-mask-invalid-url',
                }),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.equal(
                    error.message,
                    'Redis connection configuration is invalid.'
                );
                assert.ok(!('cause' in error));
                assert.ok(!('input' in error));
                assert.ok(!String(error.stack).includes(sensitive));
                assert.ok(!JSON.stringify(error).includes(sensitive));
                return true;
            }
        );
    }
});
