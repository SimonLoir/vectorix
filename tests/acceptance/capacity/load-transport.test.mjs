/** Offline in-memory transport/streams only. No SDK, sockets, files, database or resources. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { getLoadPolicy, policySha256 } from './load-policy-registry.mjs';
import {
    createLoadTransport,
    validateLoadTransportState,
    readLoadBytes,
    LoadTransportError,
    RUNTIME_DRAFT_ONLY,
    TRANSPORT_LIMITS,
} from './load-transport.mjs';
const run = '012345abcdef';
function setup(experimentPolicyId = 'DEFAULT_V1') {
    const policy = getLoadPolicy(experimentPolicyId);
    const fixture = {
        schemaVersion: 1,
        namespace: policy.namespace,
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        runId: run,
        organizationIds: ['org-a', 'org-b'],
        users: Object.fromEntries(
            ['owner', 'reader', 'foreign'].map((role) => [
                role,
                {
                    userId: 'user-' + role,
                    memberId: 'member-' + role,
                    organizationId: role === 'foreign' ? 'org-b' : 'org-a',
                    email: `${policy.emailPrefix}-${role}-${run}@example.test`,
                    password: 'SYNTHETIC_PRIVATE_PASSWORD_12345-' + role,
                },
            ])
        ),
    };
    const state = {
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        loadPolicy: structuredClone(policy.loadPolicy),
        namespace: fixture.namespace,
        runId: run,
        prefix: fixture.namespace + '-' + run,
        ports: { api: 45001, web: 45002 },
        apiOrigin: 'http://127.0.0.1:45001',
        webOrigin: 'http://127.0.0.1:45002',
        environment: {
            BETTER_AUTH_URL: 'http://127.0.0.1:45001',
            API_URL: 'http://127.0.0.1:45001',
            VECTORIX_WEB_URL: 'http://127.0.0.1:45002',
            TRUSTED_ORIGINS: 'http://127.0.0.1:45002',
        },
    };
    return { state, fixture };
}
test('both explicit policies admit only their exact namespace fixture and reject cross-policy reuse', () => {
    for (const policyId of ['DEFAULT_V1', 'LIGHT_V1']) {
        const { state, fixture } = setup(policyId);
        validateLoadTransportState(state, fixture);
        const crossed = structuredClone(fixture);
        crossed.experimentPolicySha256 = policySha256(
            getLoadPolicy(policyId === 'LIGHT_V1' ? 'DEFAULT_V1' : 'LIGHT_V1')
        );
        assert.throws(() => validateLoadTransportState(state, crossed), {
            code: 'LOAD_CONFIG',
        });
    }
});
function mock({
    mode = 'IMPORT',
    rpcResponse,
    decorateFactory,
    event,
    sleepImpl,
    sleepAdvance,
    rpcFactoryOverride,
} = {}) {
    const { state, fixture } = setup();
    let clock = 0,
        fetchCount = 0;
    const active = new Map(),
        requests = [],
        events = [];
    const fetchImpl = async (request) => {
        fetchCount++;
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.startsWith('/api/auth/')) {
            const op = url.pathname.slice('/api/auth/'.length);
            let role =
                request.headers.get('cookie')?.split('session=')[1] ?? '';
            let input;
            if (request.method === 'POST') input = await request.json();
            if (op === 'sign-in/email') {
                role = Object.keys(fixture.users).find(
                    (role) => fixture.users[role].email === input.email
                );
                return new Response(
                    JSON.stringify({
                        user: {
                            id: fixture.users[role].userId,
                            email: input.email,
                        },
                    }),
                    {
                        headers: {
                            'set-cookie': `session=${role}; HttpOnly; Path=/`,
                        },
                    }
                );
            }
            if (op === 'organization/set-active') {
                active.set(role, input.organizationId);
                return Response.json({ success: true });
            }
            if (op === 'get-session')
                return Response.json({
                    user: { id: fixture.users[role].userId },
                    session: { activeOrganizationId: active.get(role) },
                });
            assert.fail('unknownauth');
        }
        return rpcResponse ? rpcResponse(request) : Response.json({ ok: true });
    };
    const rpcFactory = (options) => {
        const factory = (operation, input) =>
            options
                .fetch(
                    new Request(
                        options.url +
                            '/admin/rag/' +
                            operation.replace('.', '/'),
                        {
                            method: 'POST',
                            body: JSON.stringify(input),
                            headers: options.headers(),
                        }
                    )
                )
                .then(async (response) => {
                    if (!response.ok)
                        throw new Error('SYNTHETIC_RAW_PROVIDER_OR_PASSWORD');
                    return response.json();
                });
        const invoke = decorateFactory
            ? decorateFactory(options, factory)
            : factory;
        return {
            admin: {
                rag: new Proxy(
                    {},
                    {
                        get: (_target, section) =>
                            new Proxy(
                                {},
                                {
                                    get: (_target, action) => (input) =>
                                        invoke(section + '.' + action, input),
                                }
                            ),
                    }
                ),
            },
        };
    };
    const api = createLoadTransport({
        state,
        fixture,
        fetchImpl,
        rpcFactory: rpcFactoryOverride ?? rpcFactory,
        mode,
        now: () => clock,
        sleep: async (ms) => {
            if (sleepImpl) await sleepImpl(ms);
            clock += sleepAdvance ? sleepAdvance(ms) : ms;
        },
        onEvent: (value) => {
            events.push(value);
            return event?.(value);
        },
    });
    return {
        api,
        state,
        fixture,
        requests,
        events,
        fetchCount: () => fetchCount,
        tick: (ms) => (clock += ms),
    };
}
async function signed(options) {
    const io = mock(options);
    await io.api.signIn();
    return io;
}
test('all runtime policy remains draft and exact new load127 namespace only', () => {
    assert.equal(RUNTIME_DRAFT_ONLY, true);
    const { state, fixture } = setup();
    validateLoadTransportState(state, fixture);
    for (const mutate of [
        (s) => (s.namespace = 'vectorix-m7c-quality'),
        (s) => (s.webOrigin = 'http://localhost:45002'),
        (s) => (s.environment.API_URL = 'http://localhost:45001'),
        (s) => (s.environment.TRUSTED_ORIGINS += ',https://foreign.invalid'),
    ]) {
        const changed = structuredClone(state);
        mutate(changed);
        assert.throws(() => validateLoadTransportState(changed, fixture));
    }
});
test('native signin binds exact fixtureuser andactiveorg; normalSDK paths are confined andreader mutation refused', async () => {
    const io = await signed();
    const result = await io.api.call('owner', 'documents.list', {
        offset: 0,
        limit: 100,
        query: '',
    });
    assert.equal(result.http.status, 200);
    assert.equal(result.value.ok, true);
    assert(result.http.bodyReadMicros >= result.http.startedMicros);
    assert.equal(io.api.counters().authCalls, 9);
    await assert.rejects(
        () =>
            io.api.call('reader', 'documents.upload', {
                file: new File(['x'], 'a.txt'),
                requestId: 'x',
            }),
        { code: 'LOAD_OPERATION' }
    );
    await assert.rejects(
        () => io.api.call('owner', 'collections.delete', { id: 'foreign' }),
        { code: 'LOAD_OPERATION' }
    );
    assert(
        io.requests.every(
            (request) => new URL(request.url).origin === io.state.apiOrigin
        )
    );
    io.api.close();
    await assert.rejects(() => io.api.call('owner', 'documents.list', {}), {
        code: 'LOAD_BUDGET',
    });
    assert(!JSON.stringify(io.events).includes('PASSWORD'));
    assert(!JSON.stringify(io.events).includes('session='));
});
test('onefetch perRPC is enforced; unexpected destinations andredirects never follow', async () => {
    for (const decorator of [
        (options, factory) => async (op, input) => {
            await factory(op, input);
            return factory(op, input);
        },
        (options) => async () =>
            options.fetch(
                new Request(
                    'http://127.0.0.2:45001/rpc/v1/admin/rag/documents/list',
                    { method: 'POST', body: '{}' }
                )
            ),
    ]) {
        const io = await signed({ decorateFactory: decorator });
        const before = io.fetchCount();
        await assert.rejects(() => io.api.call('owner', 'documents.list', {}));
        assert(io.fetchCount() - before <= 1);
    }
    let cancelled = false;
    const io = await signed({
        rpcResponse: () =>
            new Response(
                new ReadableStream({
                    cancel() {
                        cancelled = true;
                    },
                }),
                {
                    status: 302,
                    headers: { location: 'https://elsewhere.invalid' },
                }
            ),
    });
    await assert.rejects(() => io.api.call('owner', 'documents.list', {}), {
        code: 'LOAD_REDIRECT',
    });
    assert.equal(cancelled, true);
});
test('actual responsebody cap defeats understatedheaders and nonsettlingcancellation is never awaited', async () => {
    let cancelled = false;
    const io = await signed({
        rpcResponse: () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new Uint8Array(TRANSPORT_LIMITS.responseBytes)
                        );
                        controller.enqueue(new Uint8Array(1));
                    },
                    cancel() {
                        cancelled = true;
                        return new Promise(() => {});
                    },
                }),
                { headers: { 'content-length': '1' } }
            ),
    });
    await assert.rejects(() => io.api.call('owner', 'documents.list', {}), {
        code: 'LOAD_RESPONSE_CAP',
    });
    assert.equal(cancelled, true);
});
test('declared oversized body and requestbody caps reject before consuming/externaldispatch', async () => {
    const io = await signed({
        rpcResponse: () =>
            new Response('{}', {
                headers: {
                    'content-length': String(
                        TRANSPORT_LIMITS.responseBytes + 1
                    ),
                },
            }),
    });
    await assert.rejects(() => io.api.call('owner', 'documents.list', {}), {
        code: 'LOAD_RESPONSE_CAP',
    });
    const body = await signed({
        decorateFactory: (options) => async () =>
            options.fetch(
                new Request(options.url + '/admin/rag/documents/list', {
                    method: 'POST',
                    body: 'x'.repeat(TRANSPORT_LIMITS.requestBytes + 1),
                })
            ),
    });
    const before = body.fetchCount();
    await assert.rejects(() => body.api.call('owner', 'documents.list', {}));
    assert.equal(body.fetchCount(), before);
});
test('every dispatched failed mutation remains UNKNOWN even if HTTP rejection followed durable admission', async () => {
    for (const [status, expected] of [
        [401, 'UNKNOWN'],
        [403, 'UNKNOWN'],
        [404, 'UNKNOWN'],
        [429, 'UNKNOWN'],
        [500, 'UNKNOWN'],
    ]) {
        const io = await signed({
            rpcResponse: () => new Response('SYNTHETIC_SECRET', { status }),
        });
        await assert.rejects(
            () => io.api.call('owner', 'collections.create', {}),
            (error) => {
                assert.equal(error.status, status);
                assert.equal(error.acceptance, expected);
                assert(!error.message.includes('SYNTHETIC'));
                return true;
            }
        );
    }
    const io = await signed({ rpcResponse: () => new Response('not-json') });
    await assert.rejects(
        () => io.api.call('owner', 'collections.create', {}),
        (error) => error.acceptance === 'UNKNOWN' && error.code === 'LOAD_RPC'
    );
});
test('concurrent request closures retain their ownHTTP status and body timing', async () => {
    let resolveA, resolveB;
    const pending = [];
    const io = await signed({
        mode: 'TRAFFIC',
        rpcResponse: (request) =>
            new Promise((resolve) => {
                pending.push(request);
                if (pending.length === 1) resolveA = resolve;
                else resolveB = resolve;
            }),
    });
    const first = io.api.call('owner', 'indexing.search', { query: 'A' }),
        second = io.api.call('foreign', 'indexing.search', { query: 'B' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(pending.length, 2);
    io.tick(10);
    resolveB(Response.json({ which: 'B' }));
    const b = await second;
    io.tick(10);
    resolveA(new Response('rejected', { status: 429 }));
    await assert.rejects(first, (error) => error.status === 429);
    assert.equal(b.http.status, 200);
    assert.equal(b.value.which, 'B');
    assert.equal(b.http.bodyReadMicros, 10000);
    assert.equal(io.api.counters().active, 0);
});
test('ten realrequestslots areboundedperorg and no auth/cookie mutation occurs whilecallsrun', async () => {
    const resolves = [];
    const io = await signed({
        mode: 'TRAFFIC',
        rpcResponse: () => new Promise((resolve) => resolves.push(resolve)),
    });
    const calls = Array.from({ length: 5 }, () =>
        io.api.call('owner', 'indexing.search', {})
    );
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(() => io.api.call('reader', 'indexing.search', {}), {
        code: 'LOAD_CONCURRENCY',
    });
    await assert.rejects(() => io.api.signIn(), { code: 'LOAD_SESSION_BUSY' });
    assert.throws(() => io.api.close(), { code: 'LOAD_SESSION_BUSY' });
    const more = Array.from({ length: 5 }, () =>
        io.api.call('foreign', 'indexing.search', {})
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolves.length, 10);
    for (const resolve of resolves) resolve(Response.json({ ok: true }));
    await Promise.all([...calls, ...more]);
    assert.equal(io.api.counters().active, 0);
});
test('import pacing reservation excludes a second call while the first awaits localpacing', async () => {
    let block = false,
        release;
    const io = await signed({
        sleepImpl: () =>
            block
                ? new Promise((resolve) => {
                      release = resolve;
                  })
                : Promise.resolve(),
    });
    block = true;
    const first = io.api.call('owner', 'documents.list', {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(typeof release, 'function');
    await assert.rejects(() => io.api.call('owner', 'documents.list', {}), {
        code: 'LOAD_CONCURRENCY',
    });
    assert.throws(() => io.api.close(), { code: 'LOAD_SESSION_BUSY' });
    release();
    await first;
    assert.equal(io.api.counters().rpcCalls, 1);
});
test('abortedbodyless and nonsettlingbodyreadrefuse andunlock withoutleakingrejectedpromises', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => readLoadBytes(null, 10, controller.signal), {
        code: 'LOAD_CANCELLED',
    });
    let cancelled = false;
    const stream = new ReadableStream({
            pull() {
                return new Promise(() => {});
            },
            cancel() {
                cancelled = true;
                return new Promise(() => {});
            },
        }),
        current = new AbortController();
    const value = readLoadBytes(stream, 10, current.signal);
    current.abort();
    await assert.rejects(value, { code: 'LOAD_CANCELLED' });
    assert.equal(cancelled, true);
    assert.equal(stream.locked, false);
});
test('observerfailure after mutationdispatch remainsambiguous and produces no falseNOT_SENT claim', async () => {
    const io = await signed({
        event: (event) => {
            if (
                event.type === 'BODY' &&
                event.operation === 'collections.create'
            )
                throw new Error('PRIVATE_OBSERVER');
        },
    });
    await assert.rejects(
        () => io.api.call('owner', 'collections.create', {}),
        (error) =>
            error.code === 'LOAD_OBSERVER' && error.acceptance === 'UNKNOWN'
    );
});

test('installed oRPC SDK emits actual normalmultipartFile on the exact guardeduploadpath', async () => {
    const require = createRequire(path.resolve('apps/api/package.json'));
    const { createORPCClient } = await import(require.resolve('@orpc/client'));
    const { RPCLink } = await import(require.resolve('@orpc/client/fetch'));
    let observedFile = false;
    const io = await signed({
        rpcFactoryOverride: (options) => createORPCClient(new RPCLink(options)),
        rpcResponse: async (request) => {
            assert.equal(
                new URL(request.url).pathname,
                '/rpc/v1/admin/rag/documents/upload'
            );
            assert.equal(request.method, 'POST');
            assert(
                request.headers
                    .get('content-type')
                    .startsWith('multipart/form-data;')
            );
            const form = await request.formData(),
                files = [...form.values()].filter(
                    (value) => value instanceof File
                );
            assert.equal(files.length, 1);
            assert.equal(files[0].name, 'm7c-load-wire.txt');
            assert.equal(await files[0].text(), 'artificial multipart payload');
            observedFile = true;
            return new Response('{}', {
                status: 503,
                headers: { 'content-type': 'application/json' },
            });
        },
    });
    await assert.rejects(
        () =>
            io.api.call('owner', 'documents.upload', {
                requestId: '01234567-89ab-4cde-8f01-23456789abcd',
                file: new File(
                    ['artificial multipart payload'],
                    'm7c-load-wire.txt',
                    { type: 'text/plain' }
                ),
            }),
        (error) => error.status === 503 && error.acceptance === 'UNKNOWN'
    );
    assert.equal(observedFile, true);
});

test('actual HTTP BEGIN pacing follows slow SDK serialization rather than early admission', async () => {
    let io;
    io = await signed({
        decorateFactory: (_options, factory) => async (operation, input) => {
            if (input?.slow) io.tick(1500);
            if (input?.pastLifetime) io.tick(TRANSPORT_LIMITS.importMs);
            return factory(operation, input);
        },
    });
    await io.api.call('owner', 'documents.list', { slow: true });
    for (let index = 0; index < 12; index++)
        await io.api.call('owner', 'documents.list', {});
    const starts = io.events
        .filter((event) => event.type === 'BEGIN')
        .map((event) => event.atMicros);
    for (let index = 1; index < starts.length; index++)
        assert(starts[index] - starts[index - 1] >= 100000);
    for (const start of starts)
        assert(
            starts.filter((at) => at > start - 1000000 && at <= start).length <=
                10
        );
    const before = io.fetchCount();
    await assert.rejects(
        () =>
            io.api.call('owner', 'collections.create', { pastLifetime: true }),
        (error) =>
            error.code === 'LOAD_BUDGET' && error.acceptance === 'NOT_SENT'
    );
    assert.equal(io.fetchCount(), before);
});
test('fractional monotonic pacing rechecks deterministic early timer wakes without changing ten starts per second or retrying HTTP', async () => {
    const waits = [],
        io = mock({
            sleepAdvance: (requested) => {
                waits.push(requested);
                return Math.max(0.125, requested - 0.375);
            },
        });
    io.tick(0.125);
    await io.api.signIn();
    const authFetches = io.fetchCount();
    for (let index = 0; index < 12; index++)
        await io.api.call('owner', 'documents.list', {});
    assert.equal(authFetches, 9);
    assert.equal(io.fetchCount(), 21);
    assert.equal(io.api.counters().rpcCalls, 12);
    assert(waits.every((value) => Number.isInteger(value) && value > 0));
    assert(waits.filter((value) => value === 1).length > 0);
    const starts = io.events
        .filter((event) => event.type === 'BEGIN')
        .map((event) => event.atMicros);
    assert.equal(starts.length, 21);
    for (let index = 1; index < starts.length; index++)
        assert(starts[index] - starts[index - 1] >= 100000);
    for (const start of starts)
        assert(
            starts.filter((at) => at > start - 1000000 && at <= start).length <=
                10
        );
});
test('nonadvancing injected pacing clock fails before a second HTTP fetch rather than spinning or retrying', async () => {
    const io = mock({ sleepAdvance: () => 0 });
    await assert.rejects(
        () => io.api.signIn(),
        (error) => error.code === 'LOAD_BUDGET'
    );
    assert.equal(io.fetchCount(), 1);
    assert.equal(io.api.counters().active, 0);
});

test('async event writers are refused and their rejected promises consumed', async () => {
    const io = await signed({
        event: (event) => {
            if (
                event.type === 'BODY' &&
                event.operation === 'collections.create'
            )
                return Promise.reject(new Error('PRIVATE_ASYNC_WRITER'));
        },
    });
    await assert.rejects(
        () => io.api.call('owner', 'collections.create', {}),
        (error) =>
            error.code === 'LOAD_OBSERVER' && error.acceptance === 'UNKNOWN'
    );
    await new Promise((resolve) => setImmediate(resolve));
});
