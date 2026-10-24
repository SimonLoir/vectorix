import assert from 'node:assert/strict';
import { test } from 'node:test';
import { os } from '@orpc/server';
import { Hono } from 'hono';
import { z } from 'zod';
import {
    enforceApiRateLimit,
    parseApiRateLimits,
    type ApiRateLimits,
} from '@routers/utils/api-rate-limit';
import { createApiVersionRuntime } from '../api-versioning/runtime-factory';
import type { ApiErrorLogger } from '../api-versioning/error-observation';

/** In-memory stand-in for the Redis window: counts per key, never expires. */
function counter() {
    const counts = new Map<string, number>();
    const calls: [string, number, number][] = [];
    const consume = (key: string, windowSeconds: number, max: number) => {
        calls.push([key, windowSeconds, max]);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return Promise.resolve(
            count <= max
                ? { allowed: true, retryAfterSeconds: 0 }
                : { allowed: false, retryAfterSeconds: 42 }
        );
    };
    return { consume, calls };
}

const limits: ApiRateLimits = {
    principal: 3,
    principalProvider: 1,
    organizationProvider: 2,
};

void test('limits parse once, default sensibly, allow 0 and reject invalid values without echoing them', () => {
    assert.deepEqual(parseApiRateLimits({}), {
        principal: 600,
        principalProvider: 60,
        organizationProvider: 300,
    });
    assert.deepEqual(
        parseApiRateLimits({
            VECTORIX_API_RATE_LIMIT_PER_MINUTE: ' 0 ',
            VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE: '5',
            VECTORIX_API_ORGANIZATION_PROVIDER_RATE_LIMIT_PER_MINUTE: '',
        }),
        { principal: 0, principalProvider: 5, organizationProvider: 300 }
    );
    for (const value of ['-1', '1.5', 'many'])
        assert.throws(
            () =>
                parseApiRateLimits({
                    VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE: value,
                }),
            {
                message:
                    'VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE must be a non-negative integer.',
            }
        );
});

void test('principals are isolated per organization and provider calls also share an organization bucket', async () => {
    const { consume, calls } = counter();
    const keyA = { organizationId: 'org-a', keyId: 'key-1', userId: null };
    const keyB = { organizationId: 'org-a', keyId: 'key-2', userId: null };
    const user = { organizationId: 'org-b', keyId: null, userId: 'user-1' };
    const search = 'admin.rag.indexing.search';
    await enforceApiRateLimit(keyA, search, limits, undefined, consume);
    assert.deepEqual(calls, [
        ['api:org-a:key:key-1', 60, 3],
        ['api-provider:org-a:key:key-1', 60, 1],
        ['api-provider-org:org-a', 60, 2],
    ]);
    const headers = new Headers();
    await assert.rejects(
        enforceApiRateLimit(keyA, search, limits, headers, consume),
        {
            code: 'TOO_MANY_REQUESTS',
            status: 429,
            data: { retryAfterSeconds: 42 },
        }
    );
    assert.equal(headers.get('Retry-After'), '42');
    // Another key in the same organization has its own budget until the organization bucket is spent.
    await assert.rejects(
        enforceApiRateLimit(keyB, search, limits, undefined, consume),
        { code: 'TOO_MANY_REQUESTS' }
    );
    // Reads are not provider calls; other organizations are unaffected.
    await enforceApiRateLimit(
        keyB,
        'admin.rag.collections.list',
        limits,
        undefined,
        consume
    );
    await enforceApiRateLimit(user, search, limits, undefined, consume);
    await enforceApiRateLimit(
        user,
        'admin.rag.collections.list',
        { ...limits, principal: 0 },
        undefined,
        consume
    );
    assert.equal(
        calls.filter(([key]) => key === 'api:org-b:user:user-1').length,
        1
    );
});

void test('RPC and REST transports return 429 with Retry-After through the response headers plugin', async () => {
    const { consume } = counter();
    const base = os.$context<{
        logger: ApiErrorLogger;
        resHeaders?: Headers;
    }>();
    const limited = base
        .route({ method: 'POST', path: '/limited' })
        .input(z.object({}).strict())
        .output(z.object({ ok: z.boolean() }))
        .use(async ({ context, next }) => {
            await enforceApiRateLimit(
                { organizationId: 'org', keyId: 'key', userId: null },
                'admin.rag.indexing.search',
                {
                    principal: 10,
                    principalProvider: 1,
                    organizationProvider: 10,
                },
                context.resHeaders,
                consume
            );
            return next();
        })
        .handler(() => ({ ok: true }));
    const runtime = createApiVersionRuntime({ major: 1, router: { limited } });
    const logger: ApiErrorLogger = { error() {} };
    const app = new Hono();
    for (const [prefix, handler] of [
        ['/rpc/v1', runtime.rpcHandler],
        ['/api/v1', runtime.openApiHandler],
    ] as const)
        app.all(`${prefix}/*`, async (context) => {
            const result = await handler.handle(context.req.raw, {
                prefix,
                context: { logger },
            });
            return result.matched ? result.response : context.notFound();
        });
    const rest = () =>
        app.request('/api/v1/limited', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
        });
    assert.equal((await rest()).status, 200);
    const denied = await rest();
    assert.equal(denied.status, 429);
    assert.equal(denied.headers.get('Retry-After'), '42');
    const body = (await denied.json()) as { code: string; data: unknown };
    assert.equal(body.code, 'TOO_MANY_REQUESTS');
    assert.deepEqual(body.data, { retryAfterSeconds: 42 });
    const rpc = await app.request('/rpc/v1/limited', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ json: {} }),
    });
    assert.equal(rpc.status, 429);
    assert.equal(rpc.headers.get('Retry-After'), '42');
});
