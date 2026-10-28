import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import {
    createVectorixClient,
    VectorixClientError,
    VECTORIX_MAX_RESPONSE_BYTES,
    type VectorixClientErrorCode,
    type VectorixApiV1Client,
    type VectorixApiV1Outputs,
    type RetrievalSearchInput,
    type RetrievalContextInput,
    type CollectionListInput,
} from '../src/index';

const secret = 'test-api-key-never-in-diagnostics';
const headers = {
    'content-type': 'application/json',
    'Vectorix-API-Version': '1',
    'Vectorix-API-Revision': '24',
};
function wire(json: unknown, init: ResponseInit = {}, meta?: unknown[]) {
    const actual = new Headers(headers);
    for (const [name, value] of new Headers(init.headers))
        actual.set(name, value);
    return Response.json(
        { json, ...(meta ? { meta } : {}) },
        { ...init, headers: actual }
    );
}
const searchInput: RetrievalSearchInput = {
    collectionId: 'collection-a',
    query: 'forest',
};
const emptySearch = {
    generationId: 'generation-a',
    model: 'fixture',
    strategy: 'HYBRID',
    results: [],
    vectorUnderfilled: false,
    durationMs: 1,
};
function client(
    fetcher: (request: Request) => Response | Promise<Response>,
    timeoutMs = 1000
) {
    return createVectorixClient({
        apiUrl: 'https://api.example.test',
        apiKey: secret,
        organizationId: 'org-a',
        fetch: (input) => {
            assert(input instanceof Request);
            return Promise.resolve(fetcher(input));
        },
        timeoutMs,
    });
}
async function refused(
    operation: Promise<unknown>,
    code: VectorixClientErrorCode
) {
    await assert.rejects(operation, (error: unknown) => {
        assert(error instanceof VectorixClientError);
        assert.equal(error.code, code);
        assert(!String(error).includes(secret));
        assert(!JSON.stringify(error).includes('private-sentinel'));
        assert(!('cause' in error));
        return true;
    });
}

void test('the real RPC client sends the explicit key and tenant to the fixed major without ambient cookies', async () => {
    const requests: Request[] = [];
    const fetcher: typeof fetch = async (input) => {
        assert(input instanceof Request);
        requests.push(input);
        assert.equal(input.method, 'POST');
        assert.equal(input.headers.get('x-api-key'), secret);
        assert.equal(
            input.headers.get('Vectorix-Expected-Organization-Id'),
            'org-a'
        );
        assert.equal(input.headers.get('cookie'), null);
        assert.equal(input.headers.get('authorization'), null);
        assert.equal(input.credentials, 'omit');
        assert.equal(input.redirect, 'error');
        assert.equal(input.cache, 'no-store');
        assert.equal(input.referrerPolicy, 'no-referrer');
        assert.deepEqual(await input.json(), { json: searchInput });
        return wire(emptySearch);
    };
    const sdk: VectorixApiV1Client = client(fetcher);
    const result: VectorixApiV1Outputs['retrieval']['search'] =
        await sdk.retrieval.search(searchInput);
    assert.deepEqual(result, emptySearch);
    assert.equal(requests.length, 1);
    assert.equal(
        requests[0]!.url,
        'https://api.example.test/rpc/v1/retrieval/search'
    );
});

void test('stable context/citation and collection-list inputs retain defaults and Date decoding', async () => {
    const expiry = '2026-10-28T12:30:00.000Z';
    const citationWire = {
        chunkId: 'chunk-a',
        generationId: 'generation-a',
        publicationId: 'publication-a',
        documentId: 'document-a',
        documentName: 'forest.txt',
        version: 1,
        ordinal: 0,
        startOffset: 0,
        endOffset: 6,
        sourceSpans: [],
        sourceSpansTruncated: false,
        source: { receipt: 'receipt-a', expiresAt: expiry },
    };
    const inputs: unknown[] = [];
    const paths: string[] = [];
    const sdk = client(async (input) => {
        assert(input instanceof Request);
        paths.push(new URL(input.url).pathname);
        inputs.push((await input.json()).json);
        if (input.url.endsWith('/context'))
            return wire(
                {
                    anchorChunkId: 'chunk-a',
                    generationId: 'generation-a',
                    documentId: 'document-a',
                    documentName: 'forest.txt',
                    version: 1,
                    source: citationWire.source,
                    passages: [
                        { ...citationWire, text: 'forest', relation: 'MATCH' },
                    ],
                },
                {},
                [
                    [1, 'source', 'expiresAt'],
                    [1, 'passages', 0, 'source', 'expiresAt'],
                ]
            );
        return input.url.endsWith('/citation')
            ? wire(citationWire, {}, [[1, 'source', 'expiresAt']])
            : wire({ items: [], total: 0 });
    });
    const contextInput: RetrievalContextInput = {
        collectionId: 'collection-a',
        receipt: 'receipt-a',
        before: 0,
        after: 2,
    };
    const context = await sdk.retrieval.context(contextInput);
    assert(context.source.expiresAt instanceof Date);
    assert.equal(context.source.expiresAt.toISOString(), expiry);
    const citation = await sdk.retrieval.citation({
        collectionId: 'collection-a',
        receipt: 'receipt-a',
    });
    assert.equal(citation.source.expiresAt.getTime(), Date.parse(expiry));
    const listInput: CollectionListInput = {
        query: 'forest',
        limit: 1,
        offset: 0,
    };
    assert.equal((await sdk.admin.rag.collections.list(listInput)).total, 0);
    assert.deepEqual(inputs, [
        contextInput,
        { collectionId: 'collection-a', receipt: 'receipt-a' },
        listInput,
    ]);
    assert.deepEqual(paths, [
        '/rpc/v1/retrieval/context',
        '/rpc/v1/retrieval/citation',
        '/rpc/v1/admin/rag/collections/list',
    ]);
});

void test('configuration failures are local, finite and do not expose their rejected values', () => {
    let calls = 0;
    const fetcher: typeof fetch = () => {
        calls++;
        return Promise.resolve(wire(emptySearch));
    };
    for (const apiUrl of [
        'api.example.test',
        '/api/v1',
        'ftp://api.example.test',
        'https://name:private-sentinel@api.example.test',
        'https://api.example.test/api/v1',
        'https://api.example.test?private-sentinel',
        'https://api.example.test#private-sentinel',
        String.raw`https://api.example.test\foreign`,
        ' https://api.example.test',
        'https://api.example.test\n',
    ]) {
        assert.throws(
            () =>
                createVectorixClient({
                    apiUrl,
                    apiKey: secret,
                    fetch: fetcher,
                }),
            { code: 'INVALID_CONFIGURATION' }
        );
    }
    for (const apiKey of [
        '',
        ' leading-space',
        'line\nkey',
        'key\u007F',
        'x'.repeat(4097),
    ])
        assert.throws(
            () =>
                createVectorixClient({
                    apiUrl: 'https://api.example.test',
                    apiKey,
                    fetch: fetcher,
                }),
            { code: 'INVALID_CONFIGURATION' }
        );
    for (const timeoutMs of [
        0,
        -1,
        1.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        120_001,
    ])
        assert.throws(
            () =>
                createVectorixClient({
                    apiUrl: 'https://api.example.test',
                    apiKey: secret,
                    fetch: fetcher,
                    timeoutMs,
                }),
            { code: 'INVALID_CONFIGURATION' }
        );
    for (const organizationId of ['', 'x\r\ny', 'x'.repeat(129)])
        assert.throws(
            () =>
                createVectorixClient({
                    apiUrl: 'https://api.example.test',
                    apiKey: secret,
                    fetch: fetcher,
                    organizationId,
                }),
            { code: 'INVALID_CONFIGURATION' }
        );
    assert.equal(calls, 0);
});

void test('the optional organization pin is omitted rather than inferred', async () => {
    let calls = 0;
    const sdk = createVectorixClient({
        apiUrl: 'http://localhost:8080/',
        apiKey: secret,
        fetch: (input) => {
            assert(input instanceof Request);
            calls++;
            assert.equal(
                input.headers.get('Vectorix-Expected-Organization-Id'),
                null
            );
            return Promise.resolve(wire(emptySearch));
        },
    });
    await sdk.retrieval.search(searchInput);
    assert.equal(calls, 1);
});

void test('missing, malformed and foreign API metadata is refused before reading response content', async () => {
    for (const major of [null, '', '2', '01', '1, 2']) {
        let cancelled = false,
            pulls = 0;
        const sdk = client(() => {
            const actual = new Headers(headers);
            if (major === null) actual.delete('Vectorix-API-Version');
            else actual.set('Vectorix-API-Version', major);
            return new Response(
                new ReadableStream(
                    {
                        pull() {
                            pulls++;
                        },
                        cancel() {
                            cancelled = true;
                        },
                    },
                    { highWaterMark: 0 }
                ),
                { headers: actual }
            );
        });
        await refused(
            sdk.retrieval.search(searchInput),
            'UNSUPPORTED_API_VERSION'
        );
        assert.equal(pulls, 0);
        assert.equal(cancelled, true);
    }
    for (const revision of [
        null,
        '',
        '23',
        '024',
        '24.0',
        '-24',
        'NaN',
        '9999999999',
    ]) {
        const sdk = client(() => {
            const actual = new Headers(headers);
            if (revision === null) actual.delete('Vectorix-API-Revision');
            else actual.set('Vectorix-API-Revision', revision);
            return wire(emptySearch, { headers: Object.fromEntries(actual) });
        });
        // wire's default header is explicitly removed for the missing-header case.
        if (revision === null) {
            const missing = client(() =>
                Response.json(
                    { json: emptySearch },
                    {
                        headers: {
                            'content-type': 'application/json',
                            'Vectorix-API-Version': '1',
                        },
                    }
                )
            );
            await refused(
                missing.retrieval.search(searchInput),
                'UNSUPPORTED_API_REVISION'
            );
        } else
            await refused(
                sdk.retrieval.search(searchInput),
                'UNSUPPORTED_API_REVISION'
            );
    }
    assert.deepEqual(
        await client(() =>
            wire(emptySearch, { headers: { 'Vectorix-API-Revision': '25' } })
        ).retrieval.search(searchInput),
        emptySearch
    );
});

void test('server refusal and an uncertain mutation are sanitized and never automatically retried', async () => {
    let calls = 0;
    const sdk = client(() => {
        calls++;
        return wire(
            {
                defined: false,
                code: 'TOO_MANY_REQUESTS',
                status: 429,
                message: 'private-sentinel ' + secret,
                data: { apiKey: secret },
            },
            { status: 429 }
        );
    });
    await assert.rejects(
        sdk.admin.rag.collections.delete({
            id: 'collection-a',
            expectedRevision: 1,
        }),
        (error: unknown) => {
            assert(error instanceof VectorixClientError);
            assert.equal(error.code, 'API_ERROR');
            assert.equal(error.status, 429);
            assert.equal(error.serverCode, 'TOO_MANY_REQUESTS');
            assert(!String(error).includes(secret));
            assert(!JSON.stringify(error).includes(secret));
            assert(!('data' in error));
            assert(!('cause' in error));
            return true;
        }
    );
    assert.equal(calls, 1);
    await refused(
        client(() => {
            throw new Error('private-sentinel ' + secret);
        }).retrieval.search(searchInput),
        'NETWORK_ERROR'
    );
    const unknown = client(() =>
        wire(
            {
                defined: false,
                code: 'private-sentinel',
                status: 503,
                message: secret,
            },
            { status: 503 }
        )
    );
    await assert.rejects(unknown.retrieval.search(searchInput), {
        code: 'API_ERROR',
        serverCode: 'UNKNOWN',
        status: 503,
    });
});

void test('malformed RPC and response-stream failures never expose arbitrary diagnostics', async () => {
    await refused(
        client(
            () => new Response('private-sentinel ' + secret, { headers })
        ).retrieval.search(searchInput),
        'INVALID_RESPONSE'
    );
    await refused(
        client(
            () =>
                new Response(
                    new ReadableStream({
                        start(controller) {
                            controller.error(
                                new Error('private-sentinel ' + secret)
                            );
                        },
                    }),
                    { headers }
                )
        ).retrieval.search(searchInput),
        'INVALID_RESPONSE'
    );
});

void test('declared and actual response byte limits refuse rather than truncating', async () => {
    await refused(
        client(() =>
            wire(emptySearch, {
                headers: {
                    'content-length': String(VECTORIX_MAX_RESPONSE_BYTES + 1),
                },
            })
        ).retrieval.search(searchInput),
        'RESPONSE_TOO_LARGE'
    );
    let cancelled = false;
    const sdk = client(
        () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new Uint8Array(VECTORIX_MAX_RESPONSE_BYTES)
                        );
                        controller.enqueue(new Uint8Array(1));
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
                { headers: { ...headers, 'content-length': '1' } }
            )
    );
    await refused(sdk.retrieval.search(searchInput), 'RESPONSE_TOO_LARGE');
    assert.equal(cancelled, true);
});

void test('deadline stops a pending fetch and a stalled body with one request each', async () => {
    let calls = 0,
        signal: AbortSignal | undefined;
    const sdk = client(async (input) => {
        assert(input instanceof Request);
        calls++;
        signal = input.signal;
        return await new Promise<Response>(() => {});
    }, 20);
    await refused(sdk.retrieval.search(searchInput), 'TIMEOUT');
    assert.equal(calls, 1);
    assert.equal(signal?.aborted, true);
    let cancelled = false;
    const body = client(
        () =>
            new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new TextEncoder().encode('{"json":')
                        );
                    },
                    cancel() {
                        cancelled = true;
                    },
                }),
                { headers }
            ),
        20
    );
    await refused(body.retrieval.search(searchInput), 'TIMEOUT');
    assert.equal(cancelled, true);
});

void test('caller cancellation is propagated without its private reason and pre-abort dispatches nothing', async () => {
    const controller = new AbortController();
    let calls = 0;
    const sdk = client(async (input) => {
        assert(input instanceof Request);
        calls++;
        assert(!input.signal.aborted);
        controller.abort('private-sentinel ' + secret);
        return await new Promise<Response>(() => {});
    });
    await refused(
        sdk.retrieval.search(searchInput, { signal: controller.signal }),
        'ABORTED'
    );
    assert.equal(calls, 1);
    await refused(
        sdk.retrieval.search(searchInput, { signal: controller.signal }),
        'ABORTED'
    );
    assert.equal(calls, 1);
});

void test('a mocked redirect is refused and real cross-origin redirects never receive the key', async () => {
    await refused(
        client(
            () =>
                new Response(null, {
                    status: 307,
                    headers: { location: 'https://foreign.example.test' },
                })
        ).retrieval.search(searchInput),
        'REDIRECT_REFUSED'
    );
    let forwarded = 0,
        received = 0;
    const foreign = createServer((_request, response) => {
        forwarded++;
        response.end('{}');
    });
    const origin = createServer((request, response) => {
        received++;
        assert.equal(request.headers['x-api-key'], secret);
        const address = foreign.address();
        assert(address && typeof address !== 'string');
        response.writeHead(302, {
            location: `http://127.0.0.1:${address.port}/stolen`,
        });
        response.end();
    });
    try {
        foreign.listen(0, '127.0.0.1');
        await once(foreign, 'listening');
        origin.listen(0, '127.0.0.1');
        await once(origin, 'listening');
        const address = origin.address();
        assert(address && typeof address !== 'string');
        const sdk = createVectorixClient({
            apiUrl: `http://127.0.0.1:${address.port}`,
            apiKey: secret,
        });
        await refused(sdk.retrieval.search(searchInput), 'NETWORK_ERROR');
        assert.equal(received, 1);
        assert.equal(forwarded, 0);
    } finally {
        origin.closeAllConnections();
        foreign.closeAllConnections();
        await Promise.all([
            new Promise<void>((resolve) => origin.close(() => resolve())),
            new Promise<void>((resolve) => foreign.close(() => resolve())),
        ]);
    }
});
