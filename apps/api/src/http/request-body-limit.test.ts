import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { API_VERSION_REGISTRY } from '../api-versioning/registry';
import {
    DEFAULT_REQUEST_BODY_BYTES,
    DOCUMENT_REQUEST_BODY_BYTES,
    requestBodyByteLimit,
    requestBodyLimit,
} from './request-body-limit';

function guardedApp() {
    const app = new Hono();
    let calls = 0;
    app.use('*', requestBodyLimit(API_VERSION_REGISTRY));
    app.all('*', async (c) => {
        calls++;
        const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
        return c.json({
            bytes: bytes.byteLength,
            first: bytes[0],
            last: bytes.at(-1),
            method: c.req.method,
            contentType: c.req.header('content-type'),
            marker: c.req.header('x-test-marker'),
            aborted: c.req.raw.signal.aborted,
        });
    });
    return { app, calls: () => calls };
}

function streamInit(
    body: ReadableStream<Uint8Array>,
    headers: Record<string, string> = {}
) {
    return { method: 'POST', headers, body, duplex: 'half' };
}

function streamedRequest(
    path: string,
    chunks: Uint8Array[],
    headers: Record<string, string> = {}
) {
    let cancelled = 0;
    let reads = 0;
    const stream = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                const chunk = chunks[reads++];
                if (chunk) controller.enqueue(chunk);
                else controller.close();
            },
            cancel() {
                cancelled++;
            },
        },
        { highWaterMark: 0 }
    );
    const request = new Request(
        `http://localhost${path}`,
        streamInit(stream, headers)
    );
    return { request, stream, cancelled: () => cancelled, reads: () => reads };
}

void test('only the four exact POST document routes receive the upload allowance for each registered major', () => {
    const versions = [
        { rpcPath: '/rpc/v1' as const, restPath: '/api/v1' as const },
        { rpcPath: '/rpc/v2' as const, restPath: '/api/v2' as const },
    ];
    assert.equal(DEFAULT_REQUEST_BODY_BYTES, 1024 * 1024);
    assert.equal(DOCUMENT_REQUEST_BODY_BYTES, 26 * 1024 * 1024);
    for (const version of versions) {
        const paths = [
            `${version.rpcPath}/admin/rag/documents/upload`,
            `${version.rpcPath}/admin/rag/documents/replace`,
            `${version.restPath}/admin/rag/documents/uploads`,
            `${version.restPath}/admin/rag/documents/document-123/replacements`,
        ];
        for (const path of paths) {
            assert.equal(
                requestBodyByteLimit('POST', path, versions),
                DOCUMENT_REQUEST_BODY_BYTES,
                path
            );
            for (const method of [
                'GET',
                'PUT',
                'PATCH',
                'DELETE',
                'HEAD',
                'OPTIONS',
            ])
                assert.equal(
                    requestBodyByteLimit(method, path, versions),
                    DEFAULT_REQUEST_BODY_BYTES,
                    `${method} ${path}`
                );
            for (const lookalike of [
                `${path}/`,
                `${path}/extra`,
                `${path}-suffix`,
                `/prefix${path}`,
                `${path.replace('/documents/', '/documents//')}`,
            ])
                assert.equal(
                    requestBodyByteLimit('POST', lookalike, versions),
                    DEFAULT_REQUEST_BODY_BYTES,
                    lookalike
                );
        }
    }
    for (const path of [
        '/rpc/v3/admin/rag/documents/upload',
        '/api/v3/admin/rag/documents/uploads',
        '/api/v1/admin/rag/documents/a/b/replacements',
        '/api/v1/admin/rag/documents/%61/replacements',
        '/api/v1/admin/rag/documents/a%2fb/replacements',
        `/api/v1/admin/rag/documents/${'a'.repeat(129)}/replacements`,
        '/api/v1/admin/rag/documents/replacements',
        '/rpc/v1/admin/rag/documents/uploads',
        '/api/auth/sign-up/email',
        '/unmatched',
    ])
        assert.equal(
            requestBodyByteLimit('POST', path, versions),
            DEFAULT_REQUEST_BODY_BYTES,
            path
        );
});

void test('the default byte boundary is inclusive and preserves the downstream request', async () => {
    const f = guardedApp();
    const bytes = new Uint8Array(DEFAULT_REQUEST_BODY_BYTES).fill(7);
    bytes[0] = 0;
    bytes[bytes.length - 1] = 255;
    const response = await f.app.request('/api/auth/test-boundary', {
        method: 'POST',
        headers: {
            'content-type': 'application/octet-stream',
            'x-test-marker': 'preserved',
        },
        body: bytes,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        bytes: DEFAULT_REQUEST_BODY_BYTES,
        first: 0,
        last: 255,
        method: 'POST',
        contentType: 'application/octet-stream',
        marker: 'preserved',
        aborted: false,
    });
    assert.equal(f.calls(), 1);
    const rejected = await f.app.request('/api/auth/test-boundary', {
        method: 'POST',
        body: new Uint8Array(DEFAULT_REQUEST_BODY_BYTES + 1),
    });
    assert.equal(rejected.status, 413);
    assert.equal(f.calls(), 1);
});

void test('a declared oversized request is cancelled without reading or entering downstream handlers', async () => {
    const f = guardedApp();
    const body = streamedRequest(
        '/rpc/v1/admin/organization/get',
        [new Uint8Array([1])],
        {
            'content-length': String(DEFAULT_REQUEST_BODY_BYTES + 1),
        }
    );
    const response = await f.app.fetch(body.request);
    assert.equal(response.status, 413);
    assert.equal(
        response.headers.get('Vectorix-API-Revision'),
        String(API_VERSION_REGISTRY[0].revision)
    );
    assert.equal(body.reads(), 0);
    assert.equal(body.cancelled(), 1);
    assert.equal(body.stream.locked, false);
    assert.equal(f.calls(), 0);
    assert.ok(!JSON.stringify(await response.json()).includes('stack'));
});

void test('a reconstructed request retains its abort signal after admission', async () => {
    const app = new Hono();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const abort = new AbortController();
    app.use('*', requestBodyLimit(API_VERSION_REGISTRY));
    app.post('/signal', async (c) => {
        entered.resolve();
        await finish.promise;
        return c.json({ aborted: c.req.raw.signal.aborted });
    });
    const response = app.fetch(
        new Request('http://localhost/signal', {
            method: 'POST',
            body: 'accepted',
            signal: abort.signal,
        })
    );
    await entered.promise;
    abort.abort();
    finish.resolve();
    assert.deepEqual(await (await response).json(), { aborted: true });
});

void test('stream read failures are sanitized and release the reader before application parsing', async () => {
    const f = guardedApp();
    const stream = new ReadableStream<Uint8Array>(
        {
            pull(controller) {
                controller.error(new Error('private-source-diagnostic'));
            },
        },
        { highWaterMark: 0 }
    );
    const response = await f.app.fetch(
        new Request('http://localhost/broken', streamInit(stream))
    );
    assert.equal(response.status, 400);
    assert.ok(!(await response.text()).includes('private-source-diagnostic'));
    assert.equal(stream.locked, false);
    assert.equal(f.calls(), 0);
});

void test('understated and absent lengths still count actual streamed bytes and release the reader', async () => {
    const testHeaders: Record<string, string>[] = [
        {},
        { 'content-length': '1' },
    ];
    for (const headers of testHeaders) {
        const f = guardedApp();
        const body = streamedRequest(
            '/api/v1/admin/organization',
            [
                new Uint8Array(DEFAULT_REQUEST_BODY_BYTES),
                new Uint8Array([1]),
                new Uint8Array([2]),
            ],
            headers
        );
        const response = await f.app.fetch(body.request);
        assert.equal(response.status, 413);
        assert.equal(body.reads(), 2);
        assert.equal(body.cancelled(), 1);
        assert.equal(body.stream.locked, false);
        assert.equal(f.calls(), 0);
    }
});

void test(
    'rejection does not wait for an unbounded source cancellation promise',
    { timeout: 2000 },
    async () => {
        const f = guardedApp();
        let cancelled = false;
        const stream = new ReadableStream<Uint8Array>(
            {
                cancel() {
                    cancelled = true;
                    return new Promise<void>(() => {
                        // An arbitrary source may never finish cancellation.
                    });
                },
            },
            { highWaterMark: 0 }
        );
        const request = new Request(
            'http://localhost/unmatched',
            streamInit(stream, {
                'content-length': String(DEFAULT_REQUEST_BODY_BYTES + 1),
            })
        );
        assert.equal((await f.app.fetch(request)).status, 413);
        assert.equal(cancelled, true);
        assert.equal(stream.locked, false);
        assert.equal(f.calls(), 0);
    }
);

void test('the upload boundary is inclusive while one extra actual byte is refused before parsing', async () => {
    const f = guardedApp();
    const path = '/rpc/v1/admin/rag/documents/upload';
    const accepted = streamedRequest(path, [
        new Uint8Array(DOCUMENT_REQUEST_BODY_BYTES),
    ]);
    const response = await f.app.fetch(accepted.request);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bytes, DOCUMENT_REQUEST_BODY_BYTES);
    assert.equal(accepted.stream.locked, false);
    const rejected = streamedRequest(path, [
        new Uint8Array(DOCUMENT_REQUEST_BODY_BYTES),
        new Uint8Array([1]),
    ]);
    assert.equal((await f.app.fetch(rejected.request)).status, 413);
    assert.equal(rejected.cancelled(), 1);
    assert.equal(rejected.stream.locked, false);
    assert.equal(f.calls(), 1);
});

void test('real chunked HTTP is bounded without Content-Length and the server is closed afterwards', async () => {
    const f = guardedApp();
    const server = serve({
        fetch: f.app.fetch,
        hostname: '127.0.0.1',
        port: 0,
    });
    if (!server.listening) await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
        const response = await new Promise<{
            status: number;
            headers: Record<string, string | string[] | undefined>;
            body: string;
        }>((resolve, reject) => {
            const request = httpRequest(
                {
                    hostname: '127.0.0.1',
                    port: address.port,
                    method: 'POST',
                    path: '/rpc/v1/admin/organization/get',
                    headers: {
                        'content-type': 'application/json',
                        'transfer-encoding': 'chunked',
                        connection: 'close',
                    },
                },
                (incoming) => {
                    const chunks: Buffer[] = [];
                    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
                    incoming.on('end', () =>
                        resolve({
                            status: incoming.statusCode ?? 0,
                            headers: incoming.headers,
                            body: Buffer.concat(chunks).toString(),
                        })
                    );
                    incoming.on('error', reject);
                }
            );
            request.on('error', reject);
            request.setTimeout(10_000, () =>
                request.destroy(new Error('Chunked request timed out.'))
            );
            request.write(Buffer.alloc(DEFAULT_REQUEST_BODY_BYTES));
            request.end(Buffer.from([1]));
        });
        assert.equal(response.status, 413);
        assert.equal(
            response.headers['vectorix-api-revision'],
            String(API_VERSION_REGISTRY[0].revision)
        );
        assert.ok(!response.body.includes('stack'));
        assert.equal(f.calls(), 0);
    } finally {
        if ('closeAllConnections' in server) server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        );
    }
});
