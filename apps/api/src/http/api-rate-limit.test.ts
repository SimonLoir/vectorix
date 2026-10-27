import assert from 'node:assert/strict';
import { test } from 'node:test';
import { os } from '@orpc/server';
import { Hono } from 'hono';
import { z } from 'zod';
import {
    createProviderRateLimitAdmission,
    enforceApiRateLimit,
    MAX_API_RATE_LIMIT_PER_MINUTE,
    parseApiRateLimits,
    PROVIDER_OPERATIONS,
    type ApiRateLimits,
} from '@routers/utils/api-rate-limit';
import type { RateLimitPolicy } from '@repo/queues/rate-limit';
import { createApiVersionRuntime } from '../api-versioning/runtime-factory';
import type { ApiErrorLogger } from '../api-versioning/error-observation';

/** Fixed nonexpiring counters isolate admission order from Redis timing tests. */
function counter() {
    const counts = new Map<string, number>();
    const calls: [string, number, number, RateLimitPolicy][] = [];
    const consume = (
        key: string,
        windowSeconds: number,
        maximum: number,
        policy: RateLimitPolicy = 'LAST_ALLOWED'
    ) => {
        calls.push([key, windowSeconds, maximum, policy]);
        const count = counts.get(key) ?? 0;
        if (count >= maximum)
            return Promise.resolve({ allowed: false, retryAfterSeconds: 42 });
        counts.set(key, count + 1);
        return Promise.resolve({ allowed: true, retryAfterSeconds: 0 });
    };
    return { consume, calls };
}
const limits: ApiRateLimits = {
    principal: 3,
    principalProvider: 1,
    organizationProvider: 2,
};
const keyA = { organizationId: 'org-a', keyId: 'key-1', userId: null };
const keyB = { organizationId: 'org-a', keyId: 'key-2', userId: null };

void test('all startup budgets enforce the documented safe bound without disclosing input', () => {
    assert.deepEqual(parseApiRateLimits({}), {
        principal: 600,
        principalProvider: 60,
        organizationProvider: 300,
    });
    for (const [variable, field] of [
        ['VECTORIX_API_RATE_LIMIT_PER_MINUTE', 'principal'],
        ['VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE', 'principalProvider'],
        [
            'VECTORIX_API_ORGANIZATION_PROVIDER_RATE_LIMIT_PER_MINUTE',
            'organizationProvider',
        ],
    ] as const) {
        for (const value of [
            ' 0 ',
            '1',
            String(MAX_API_RATE_LIMIT_PER_MINUTE),
        ]) {
            assert.equal(
                parseApiRateLimits({ [variable]: value })[field],
                Number(value)
            );
        }
        for (const value of [
            '-1',
            '1.5',
            '1e3',
            'Infinity',
            'NaN',
            'private-input-marker',
            String(MAX_API_RATE_LIMIT_PER_MINUTE + 1),
            String(Number.MAX_SAFE_INTEGER),
            '9'.repeat(400),
        ]) {
            assert.throws(() => parseApiRateLimits({ [variable]: value }), {
                message: variable + ' must be an integer from 0 to 1000000.',
            });
        }
    }
    assert.deepEqual(
        parseApiRateLimits({
            VECTORIX_API_RATE_LIMIT_PER_MINUTE: '',
            VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE: ' ',
        }),
        { principal: 600, principalProvider: 60, organizationProvider: 300 }
    );
});

void test('the personal anti-loop budget cannot touch provider or organization counters', async () => {
    const { consume, calls } = counter();
    const headers = new Headers();
    await enforceApiRateLimit(
        keyA,
        { ...limits, principal: 1 },
        headers,
        consume
    );
    await assert.rejects(
        enforceApiRateLimit(
            keyA,
            { ...limits, principal: 1 },
            headers,
            consume
        ),
        {
            code: 'TOO_MANY_REQUESTS',
            status: 429,
            data: { retryAfterSeconds: 42 },
        }
    );
    assert.equal(headers.get('Retry-After'), '42');
    assert.deepEqual(calls, [
        ['api:org-a:key:key-1', 60, 1, 'FIXED'],
        ['api:org-a:key:key-1', 60, 1, 'FIXED'],
    ]);
});

void test('provider admission is memoized and a personal provider refusal preserves the shared budget', async () => {
    const { consume, calls } = counter();
    const first = createProviderRateLimitAdmission(
        keyA,
        limits,
        undefined,
        consume
    );
    await Promise.all([first(), first(), first()]);
    assert.deepEqual(calls, [
        ['api-provider:org-a:key:key-1', 60, 1, 'FIXED'],
        ['api-provider-org:org-a', 60, 2, 'FIXED'],
    ]);
    const headers = new Headers();
    const exhausted = createProviderRateLimitAdmission(
        keyA,
        limits,
        headers,
        consume
    );
    await assert.rejects(exhausted(), { code: 'TOO_MANY_REQUESTS' });
    await assert.rejects(exhausted(), { code: 'TOO_MANY_REQUESTS' });
    assert.equal(headers.get('Retry-After'), '42');
    assert.equal(
        calls.filter(([key]) => key === 'api-provider-org:org-a').length,
        1
    );
    assert.equal(
        calls.filter(([key]) => key === 'api-provider:org-a:key:key-1').length,
        2
    );
    await createProviderRateLimitAdmission(keyB, limits, undefined, consume)();
    assert.equal(
        calls.filter(([key]) => key === 'api-provider-org:org-a').length,
        2
    );
});

void test('shared limits preserve actor/org isolation and disabled buckets are not dispatched', async () => {
    const { consume, calls } = counter();
    await createProviderRateLimitAdmission(keyA, limits, undefined, consume)();
    await createProviderRateLimitAdmission(keyB, limits, undefined, consume)();
    await assert.rejects(
        createProviderRateLimitAdmission(
            { ...keyA, keyId: 'key-3' },
            limits,
            undefined,
            consume
        )(),
        { code: 'TOO_MANY_REQUESTS' }
    );
    await createProviderRateLimitAdmission(
        { ...keyA, organizationId: 'org-b' },
        limits,
        undefined,
        consume
    )();
    const before = calls.length;
    await enforceApiRateLimit(
        keyA,
        { ...limits, principal: 0 },
        undefined,
        consume
    );
    await createProviderRateLimitAdmission(
        keyA,
        {
            principal: 0,
            principalProvider: 0,
            organizationProvider: 0,
        },
        undefined,
        consume
    )();
    assert.equal(calls.length, before);
});

void test('RPC and REST preserve 429 and Retry-After through the response-header plugin', async () => {
    const { consume } = counter();
    const base = os.$context<{
        logger: ApiErrorLogger;
        resHeaders?: Headers;
    }>();
    const rule = {
        principal: 10,
        principalProvider: 1,
        organizationProvider: 10,
    };
    const principal = { organizationId: 'org', keyId: 'key', userId: null };
    const limited = base
        .route({ method: 'POST', path: '/limited' })
        .input(z.object({}).strict())
        .output(z.object({ ok: z.boolean() }))
        .use(async ({ context, next }) => {
            await enforceApiRateLimit(
                principal,
                rule,
                context.resHeaders,
                consume
            );
            await createProviderRateLimitAdmission(
                principal,
                rule,
                context.resHeaders,
                consume
            )();
            return next();
        })
        .handler(() => ({ ok: true }));
    const runtime = createApiVersionRuntime({ major: 1, router: { limited } });
    const logger: ApiErrorLogger = { error() {} };
    const app = new Hono();
    for (const [prefix, handler] of [
        ['/rpc/v1', runtime.rpcHandler],
        ['/api/v1', runtime.openApiHandler],
    ] as const) {
        app.all(prefix + '/*', async (context) => {
            const result = await handler.handle(context.req.raw, {
                prefix,
                context: { logger },
            });
            return result.matched ? result.response : context.notFound();
        });
    }
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

void test('optional reranked search receives the same provider-request admission while metadata stays free of provider cost', () => {
    assert(PROVIDER_OPERATIONS.has('admin.rag.reranking.search'));
    for (const operation of ['profile', 'configure', 'usage'])
        assert.equal(
            PROVIDER_OPERATIONS.has(`admin.rag.reranking.${operation}`),
            false
        );
});

void test('retrieval search shares provider admission while citation and context remain application reads', () => {
    assert(PROVIDER_OPERATIONS.has('retrieval.search'));
    assert.equal(PROVIDER_OPERATIONS.has('retrieval.citation'), false);
    assert.equal(PROVIDER_OPERATIONS.has('retrieval.context'), false);
});
