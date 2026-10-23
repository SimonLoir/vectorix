import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
    VECTORIX_CSRF_HEADER,
    VECTORIX_CSRF_VALUE,
} from '@repo/api/transport-security';
import { cookieCsrfDecision, cookieCsrfProtection } from './cookie-csrf';
import { resolveTrustedOrigins } from './trusted-origins';

const origins = resolveTrustedOrigins(
    'https://web.example.test,https://admin.example.test'
);
const versions = [
    {
        major: 1,
        revision: 18,
        status: 'current',
        rpcPath: '/rpc/v1',
        restPath: '/api/v1',
    },
    {
        major: 2,
        revision: 4,
        status: 'deprecated',
        rpcPath: '/rpc/v2',
        restPath: '/api/v2',
    },
] as const;

function headerValues(values: Record<string, string | undefined>) {
    const entries = new Map<string, string>();
    for (const [key, value] of Object.entries(values))
        if (value !== undefined) entries.set(key.toLowerCase(), value);
    return { get: (name: string) => entries.get(name.toLowerCase()) ?? null };
}

function streamRequest(
    url: string,
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string>
) {
    const init = { method: 'POST', headers, body, duplex: 'half' as const };
    return new Request(url, init);
}

void test('safe methods and requests without cookies retain their existing authentication path', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS'])
        assert.equal(
            cookieCsrfDecision(
                method,
                headerValues({ cookie: 'synthetic', origin: 'null' }),
                origins
            ),
            true
        );
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
        for (const credentials of [
            {},
            { 'x-api-key': 'synthetic-key' },
            { authorization: 'Bearer synthetic-token' },
        ])
            assert.equal(
                cookieCsrfDecision(
                    method,
                    headerValues({ ...credentials, origin: 'null' }),
                    origins
                ),
                true
            );
});

void test('a present Origin is authoritative and neither Referer nor the public marker rescues a hostile or malformed one', () => {
    for (const origin of origins)
        assert.equal(
            cookieCsrfDecision(
                'POST',
                headerValues({
                    cookie: 'synthetic',
                    origin,
                    referer: 'https://hostile.example.test/',
                }),
                origins
            ),
            true
        );
    for (const origin of [
        '',
        'null',
        'https://hostile.example.test',
        'https://web.example.test.evil.invalid',
        'https://web.example.test/',
        'https://@web.example.test',
        'https://web.example.test#',
        'https://web.example.test, https://hostile.example.test',
        'https://web.exa\tmple.test',
    ])
        assert.equal(
            cookieCsrfDecision(
                'POST',
                headerValues({
                    cookie: 'synthetic',
                    origin,
                    referer: origins[0]! + '/dashboard',
                    [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
                }),
                origins
            ),
            false,
            origin
        );
});

void test('only absent Origin permits Referer fallback; a present invalid Referer cannot be rescued by a marker', () => {
    assert.equal(
        cookieCsrfDecision(
            'POST',
            headerValues({
                cookie: 'synthetic',
                referer: origins[0]! + '/dashboard?tab=documents',
            }),
            origins
        ),
        true
    );
    for (const referer of [
        '',
        'null',
        '/dashboard',
        'https://hostile.example.test/path',
        'https://web.example.test.evil.invalid/path',
        'https://user@web.example.test/path',
        'https://@web.example.test/path',
        'https://web.example.test/path#',
        'https://web.example.test/path, https://evil.invalid/',
        String.raw`https://web.example.test\@evil.invalid/`,
    ])
        assert.equal(
            cookieCsrfDecision(
                'POST',
                headerValues({
                    cookie: 'synthetic',
                    referer,
                    [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
                }),
                origins
            ),
            false,
            referer
        );
});

void test('the marker is exact and only serves requests with both Origin and Referer absent, including SSR with navigation metadata removed', () => {
    for (const value of ['', 'ORPC', 'orpc, orpc', 'other'])
        assert.equal(
            cookieCsrfDecision(
                'POST',
                headerValues({
                    cookie: 'synthetic',
                    [VECTORIX_CSRF_HEADER]: value,
                }),
                origins
            ),
            false
        );
    assert.equal(
        cookieCsrfDecision(
            'POST',
            headerValues({ cookie: 'synthetic' }),
            origins
        ),
        false
    );
    assert.equal(
        cookieCsrfDecision(
            'POST',
            headerValues({
                cookie: 'synthetic',
                [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
            }),
            origins
        ),
        true
    );
});

void test('cookies combined with keys or bearer never bypass Origin checks, even an empty Cookie header', () => {
    for (const cookie of ['', 'synthetic=session'])
        for (const extra of [
            { 'x-api-key': 'synthetic-key' },
            { 'x-api-key': '' },
            { authorization: 'Bearer synthetic-token' },
            { authorization: 'Bearer invalid' },
        ])
            assert.equal(
                cookieCsrfDecision(
                    'POST',
                    headerValues({
                        cookie,
                        origin: 'https://hostile.example.test',
                        [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
                        ...extra,
                    }),
                    origins
                ),
                false
            );
});

void test('Fetch Metadata, Host and proxy headers never establish origin trust, and a configured cross-site origin remains explicit', () => {
    for (const site of ['same-site', 'same-origin', 'none', 'cross-site'])
        assert.equal(
            cookieCsrfDecision(
                'POST',
                headerValues({
                    cookie: 'synthetic',
                    'sec-fetch-site': site,
                    host: 'web.example.test',
                    'x-forwarded-host': 'web.example.test',
                    'x-forwarded-proto': 'https',
                }),
                origins
            ),
            false
        );
    assert.equal(
        cookieCsrfDecision(
            'POST',
            headerValues({
                cookie: 'synthetic',
                origin: origins[0]!,
                'sec-fetch-site': 'cross-site',
            }),
            origins
        ),
        true
    );
});

function guardedApp() {
    const app = new Hono();
    let calls = 0;
    app.use(
        '*',
        cors({
            origin: origins,
            credentials: true,
            allowMethods: [
                'GET',
                'HEAD',
                'POST',
                'PUT',
                'PATCH',
                'DELETE',
                'OPTIONS',
            ],
            allowHeaders: ['Content-Type', VECTORIX_CSRF_HEADER],
        })
    );
    app.use('*', cookieCsrfProtection(versions, origins));
    app.all('*', async (context) => {
        calls++;
        return context.json({
            text: await context.req.raw.text(),
            method: context.req.method,
            marker: context.req.header(VECTORIX_CSRF_HEADER),
            aborted: context.req.raw.signal.aborted,
        });
    });
    return { app, calls: () => calls };
}

void test('every supported prefix refuses before a body pull, with exact RPC/REST error envelopes and version metadata', async () => {
    const { app, calls } = guardedApp();
    for (const version of versions)
        for (const [prefix, rpc] of [
            [version.rpcPath, true],
            [version.restPath, false],
        ] as const) {
            let reads = 0,
                cancellations = 0;
            const body = new ReadableStream<Uint8Array>(
                {
                    pull() {
                        reads++;
                        assert.fail('forbidden request body was pulled');
                    },
                    cancel() {
                        cancellations++;
                    },
                },
                { highWaterMark: 0 }
            );
            const response = await app.request(
                streamRequest(
                    'https://api.example.test' + prefix + '/private',
                    body,
                    {
                        cookie: 'PRIVATE_COOKIE',
                        origin: 'https://PRIVATE_HOSTILE.example.test',
                    }
                )
            );
            assert.equal(response.status, 403);
            assert.equal(reads, 0);
            assert.equal(cancellations, 0);
            assert.equal(calls(), 0);
            assert.equal(
                response.headers.get('Vectorix-API-Version'),
                String(version.major)
            );
            assert.equal(
                response.headers.get('Vectorix-API-Revision'),
                String(version.revision)
            );
            assert.equal(
                response.headers.get('Deprecation'),
                version.status === 'deprecated' ? 'true' : null
            );
            const error = {
                defined: false,
                code: 'FORBIDDEN',
                status: 403,
                message: 'Request origin is not allowed.',
            };
            const payload: unknown = await response.json();
            assert.deepEqual(payload, rpc ? { json: error } : error);
            assert(!JSON.stringify(payload).includes('PRIVATE_'));
        }
});

void test(
    'refusal leaves a producer with nonsettling cancellation untouched',
    { timeout: 1000 },
    async () => {
        const { app, calls } = guardedApp();
        let cancellations = 0;
        const body = new ReadableStream<Uint8Array>(
            {
                cancel() {
                    cancellations++;
                    return new Promise<void>(() => {});
                },
            },
            { highWaterMark: 0 }
        );
        const response = await app.request(
            streamRequest('https://api.example.test/rpc/v1/private', body, {
                cookie: 'synthetic',
            })
        );
        assert.equal(response.status, 403);
        assert.equal(cancellations, 0);
        assert.equal(calls(), 0);
    }
);

void test('exact slash boundaries leave auth, unsupported majors and lookalike prefixes to their own handlers', async () => {
    const { app, calls } = guardedApp();
    for (const path of [
        '/api/auth/update-user',
        '/api/v10/private',
        '/rpc/v10/private',
        '/rpc/v3/private',
        '/api/v1-other/private',
        '/prefix/rpc/v1/private',
    ]) {
        const response = await app.request('https://api.example.test' + path, {
            method: 'POST',
            headers: { cookie: 'synthetic' },
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('Vectorix-API-Version'), null);
    }
    assert.equal(calls(), 6);
    for (const path of ['/api/v1', '/rpc/v1']) {
        const response = await app.request('https://api.example.test' + path, {
            method: 'POST',
            headers: { cookie: 'synthetic' },
        });
        assert.equal(response.status, 403);
    }
    assert.equal(calls(), 6);
});

void test('accepted origin and originless-marker requests preserve body bytes and signal while CORS preflight remains independent', async () => {
    const { app, calls } = guardedApp();
    const acceptedHeaders: Record<string, string>[] = [
        { cookie: 'synthetic', origin: origins[0]! },
        { cookie: 'synthetic', [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE },
    ];
    for (const headers of acceptedHeaders) {
        const response = await app.request(
            'https://api.example.test/rpc/v1/private',
            {
                method: 'POST',
                headers: { ...headers, 'content-type': 'text/plain' },
                body: 'Exact text — 🧭\n',
            }
        );
        assert.equal(response.status, 200);
        const payload = await response.json();
        assert.equal(payload.text, 'Exact text — 🧭\n');
        assert.equal(payload.aborted, false);
        assert.equal(payload.method, 'POST');
    }
    assert.equal(calls(), 2);
    for (const origin of [origins[0]!, 'https://hostile.example.test']) {
        const response = await app.request(
            'https://api.example.test/api/v1/private',
            {
                method: 'OPTIONS',
                headers: {
                    cookie: 'synthetic',
                    origin,
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': VECTORIX_CSRF_HEADER,
                },
            }
        );
        assert.equal(response.status, 204);
        assert.equal(
            response.headers.get('access-control-allow-origin'),
            origin === origins[0] ? origin : null
        );
        assert(
            response.headers
                .get('access-control-allow-headers')
                ?.includes(VECTORIX_CSRF_HEADER)
        );
    }
    assert.equal(calls(), 2);
});
