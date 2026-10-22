import assert from 'node:assert/strict';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import {
    discoverModels,
    verifyEmbeddingModel,
    embedDocuments,
    embedQuery,
    canonicalEmbeddingModel,
    embeddingIdentityKind,
    modelIdentity,
    embeddingInputByteLimit,
    EmbeddingError,
    type CohereConfiguration,
    type ModelIdentity,
} from '../src/index';
import { requestJson } from '../src/http';

type Body = {
    model?: string;
    texts?: string[];
    input_type?: string;
    output_dimension?: number;
    embedding_types?: string[];
    truncate?: string;
};
type Request = {
    path: string;
    body: Body;
    authorization?: string;
    bytes: number;
};
type Handler = (
    request: IncomingMessage,
    response: ServerResponse,
    body: Body
) => boolean | void | Promise<boolean | void>;
const key = 'private-cohere-fixture-key';
const selected = {
    model: 'embed-v4.0',
    dimensions: 256,
    preset: 'GENERIC' as const,
};
const listed = (name: string) => ({
    name,
    endpoints: ['embed'],
    ['is_deprecated']: false,
});
function result(body: Body) {
    const dimensions =
        body.output_dimension ?? (body.model === 'embed-v4.0' ? 1536 : 1024);
    return {
        embeddings: {
            float: body.texts!.map((text, index) =>
                Array.from({ length: dimensions }, (_, dimension) =>
                    dimension === 0
                        ? Number(text.match(/^doc(\d+)$/)?.[1] ?? index) + 1
                        : dimension / 10_000
                )
            ),
        },
        texts: body.texts,
        meta: {
            tokens: { ['input_tokens']: body.texts!.length * 7 },
            ['billed_units']: { ['input_tokens']: body.texts!.length * 5 },
        },
    };
}
async function fixture(
    run: (config: CohereConfiguration, requests: Request[]) => Promise<void>,
    handler?: Handler
) {
    const requests: Request[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const value of request as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(value));
        const bytes = Buffer.concat(chunks);
        const body = bytes.length ? (JSON.parse(bytes.toString()) as Body) : {};
        requests.push({
            path: request.url!,
            body,
            authorization: request.headers.authorization,
            bytes: bytes.length,
        });
        if (await handler?.(request, response, body)) return;
        response.setHeader('Content-Type', 'application/json');
        if (request.url?.startsWith('/v1/models'))
            response.end(
                JSON.stringify({
                    models: [
                        listed('embed-v4.0'),
                        listed('embed-english-v3.0'),
                        listed('embed-multilingual-v3.0'),
                    ],
                })
            );
        else if (request.url === '/v2/embed')
            response.end(JSON.stringify(result(body)));
        else {
            response.writeHead(404);
            response.end();
        }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    try {
        await run(
            {
                provider: 'COHERE',
                endpoint: `http://127.0.0.1:${address.port}`,
                apiKey: key,
            },
            requests
        );
    } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
}
const errorCode = (code: string) => (error: unknown) =>
    error instanceof EmbeddingError &&
    error.code === code &&
    !error.message.includes(key) &&
    !('cause' in error) &&
    !('response' in error);
const embeddings = (requests: Request[]) =>
    requests.filter((request) => request.path === '/v2/embed');

await test('authenticated hosted discovery intersects native catalog with the reviewed allowlist and labels its identity truthfully', () =>
    fixture(
        async (config, requests) => {
            const models = await discoverModels(config);
            assert.deepEqual(
                models.map((model) => model.model),
                ['embed-v4.0', 'embed-multilingual-v3.0']
            );
            assert.deepEqual(
                models[0]?.supportedDimensions,
                [256, 512, 1024, 1536]
            );
            assert.equal(models[0]?.defaultDimensions, 1536);
            assert.equal(models[0]?.contextTokens, 128_000);
            assert.equal(models[0]?.identityKind, 'CAPABILITY_PROFILE');
            assert.equal(models[0]?.discoverySource, 'HOSTED_CATALOG');
            assert.match(models[0]!.digest, /^[a-f0-9]{64}$/);
            assert.equal(requests.length, 1);
            assert.equal(
                new URL(requests[0]!.path, config.endpoint).searchParams.get(
                    'endpoint'
                ),
                'embed'
            );
            assert.equal(requests[0]?.authorization, `Bearer ${key}`);
            assert.equal(embeddings(requests).length, 0);
        },
        (_request, response) => {
            response.end(
                JSON.stringify({
                    models: [
                        listed('embed-v5.0-fast'),
                        listed('embed-english-light-v3.0'),
                        listed('embed-v4.0'),
                        {
                            ...listed('embed-english-v3.0'),
                            ['is_deprecated']: true,
                        },
                        listed('embed-multilingual-v3.0'),
                    ],
                })
            );
            return true;
        }
    ));

await test('bounded discovery follows encoded page tokens, handles empty final tokens and rejects loops or excess pages', async () => {
    await fixture(
        async (config, requests) => {
            assert.equal((await discoverModels(config)).length, 2);
            const url = new URL(requests[1]!.path, config.endpoint);
            assert.equal(url.searchParams.get('page_token'), 'next/a?b&c');
        },
        (request, response) => {
            const second = new URL(
                request.url!,
                'http://fixture'
            ).searchParams.has('page_token');
            response.end(
                JSON.stringify({
                    models: [
                        listed(
                            second ? 'embed-multilingual-v3.0' : 'embed-v4.0'
                        ),
                    ],
                    ['next_page_token']: second ? '' : 'next/a?b&c',
                })
            );
            return true;
        }
    );
    for (const loop of [true, false])
        await fixture(
            async (config, requests) => {
                await assert.rejects(
                    discoverModels(config),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
                assert.equal(requests.length, loop ? 2 : 5);
            },
            (request, response) => {
                const token =
                    new URL(request.url!, 'http://fixture').searchParams.get(
                        'page_token'
                    ) ?? '';
                response.end(
                    JSON.stringify({
                        models: [],
                        ['next_page_token']: loop ? 'repeat' : `${token}a`,
                    })
                );
                return true;
            }
        );
});

await test('probe verifies both native roles at selected dimensions and persists a deterministic non-weights profile', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        assert.equal(identity.schemaVersion, 2);
        assert.equal(identity.provider, 'COHERE');
        assert.equal(embeddingIdentityKind(identity), 'CAPABILITY_PROFILE');
        const persistedJson = JSON.stringify(identity);
        assert.deepEqual(
            modelIdentity.parse(JSON.parse(persistedJson)),
            identity
        );
        const probes = embeddings(requests);
        assert.deepEqual(
            probes.map((request) => request.body.input_type),
            ['search_document', 'search_query']
        );
        assert(
            probes.every(
                (request) =>
                    request.body.output_dimension === 256 &&
                    request.body.truncate === 'NONE' &&
                    request.body.embedding_types?.join(',') === 'float'
            )
        );
        assert(
            probes.every((request) => request.authorization === `Bearer ${key}`)
        );
        assert.deepEqual(
            await verifyEmbeddingModel(config, selected),
            identity
        );
    }));

await test('v4 verifies every supported dimension and v3 omits unsupported output_dimension', async () => {
    await fixture(async (config) => {
        for (const dimensions of [256, 512, 1024, 1536])
            assert.equal(
                (
                    await verifyEmbeddingModel(config, {
                        ...selected,
                        dimensions,
                    })
                ).dimensions,
                dimensions
            );
    });
    for (const model of ['embed-english-v3.0', 'embed-multilingual-v3.0'])
        await fixture(async (config, requests) => {
            const identity = await verifyEmbeddingModel(config, {
                ...selected,
                model,
                dimensions: 1024,
            });
            assert.equal(identity.contextTokens, 512);
            assert.equal(identity.defaultDimensions, 1024);
            assert(
                embeddings(requests).every(
                    (request) =>
                        !Object.hasOwn(request.body, 'output_dimension')
                )
            );
            await embedQuery(config, identity, 'A query');
            assert.equal(
                embeddings(requests).at(-1)?.body.input_type,
                'search_query'
            );
        });
});

await test('unsupported models, reductions and foreign presets fail before provider cost', () =>
    fixture(async (config, requests) => {
        for (const input of [
            { ...selected, model: 'embed-v5.0-fast' },
            { ...selected, model: 'embed-english-light-v3.0' },
            { ...selected, preset: 'EMBEDDING_GEMMA' as const },
        ])
            await assert.rejects(
                verifyEmbeddingModel(config, input),
                errorCode('MODEL_UNSUPPORTED')
            );
        for (const input of [
            { ...selected, dimensions: 128 },
            { ...selected, model: 'embed-multilingual-v3.0', dimensions: 256 },
        ])
            await assert.rejects(
                verifyEmbeddingModel(config, input),
                errorCode('DIMENSIONS_UNSUPPORTED')
            );
        assert.equal(requests.length, 0);
    }));

await test('an unavailable allowlisted model fails rather than falling back to another model', () =>
    fixture(
        async (config, requests) => {
            await assert.rejects(
                verifyEmbeddingModel(config, selected),
                errorCode('MODEL_NOT_FOUND')
            );
            assert.equal(embeddings(requests).length, 0);
        },
        (_request, response) => {
            response.end(
                JSON.stringify({ models: [listed('embed-multilingual-v3.0')] })
            );
            return true;
        }
    ));

await test('native roles preserve literal preparation, ignore undeclared title prompts and report model tokens separately from billed tokens', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const documents = await embedDocuments(
            config,
            identity,
            [{ text: 'Le document', title: 'Do not invent a title prompt' }],
            { preparation: 'Préparation' }
        );
        const query = await embedQuery(config, identity, 'La question', {
            preparation: 'Préparation',
        });
        assert.deepEqual(embeddings(requests).at(-2)?.body.texts, [
            'Préparation\nLe document',
        ]);
        assert.deepEqual(embeddings(requests).at(-1)?.body.texts, [
            'Préparation\nLa question',
        ]);
        assert.equal(
            embeddings(requests).at(-2)?.body.input_type,
            'search_document'
        );
        assert.equal(
            embeddings(requests).at(-1)?.body.input_type,
            'search_query'
        );
        assert.equal(documents.usage.providerInputTokens, 7);
        assert.equal(documents.usage.billedInputTokens, 5);
        assert.equal(query.usage.requests, 1);
        assert.equal(
            query.usage.estimatedInputTokens,
            Math.ceil(Buffer.byteLength('Préparation\nLa question') / 4)
        );
    }));

await test('batches at most 96 texts, preserves response ordering and aggregates independent usage across batches', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const embedded = await embedDocuments(
            config,
            identity,
            Array.from({ length: 193 }, (_, index) => ({ text: `doc${index}` }))
        );
        assert.deepEqual(
            embeddings(requests)
                .slice(2)
                .map((request) => request.body.texts?.length),
            [96, 96, 1]
        );
        assert.deepEqual(
            embedded.vectors.map((vector) => vector[0]),
            Array.from({ length: 193 }, (_, index) => index + 1)
        );
        assert.equal(embedded.usage.providerInputTokens, 193 * 7);
        assert.equal(embedded.usage.billedInputTokens, 193 * 5);
        assert.equal(embedded.usage.requests, 3);
    }));

await test('request byte limits split large bounded inputs before the 96-text count limit', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const embedded = await embedDocuments(
            config,
            identity,
            Array.from({ length: 20 }, () => ({ text: '\\'.repeat(60_000) }))
        );
        assert.equal(embedded.vectors.length, 20);
        assert(embedded.usage.requests > 1);
        assert(
            embeddings(requests).every(
                (request) =>
                    request.bytes < 2 * 1024 * 1024 &&
                    request.body.texts!.length <= 96
            )
        );
    }));

await test('missing model and billing metadata remain independently unknown rather than estimates or fabricated billing', () =>
    fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, selected);
            const value = await embedDocuments(config, identity, [
                { text: 'text' },
            ]);
            assert.equal(value.usage.providerInputTokens, null);
            assert.equal(value.usage.billedInputTokens, 12);
            assert(value.usage.estimatedInputTokens > 0);
        },
        (request, response, body) => {
            if (request.url !== '/v2/embed') return;
            const value = result(body);
            response.end(
                JSON.stringify({
                    ...value,
                    meta: { ['billed_units']: { ['input_tokens']: 12 } },
                })
            );
            return true;
        }
    ));

for (const [name, corrupt] of Object.entries({
    count: (vectors: number[][]) => vectors.slice(1),
    dimensions: (vectors: number[][]) =>
        vectors.map((vector) => vector.slice(1)),
    zero: (vectors: number[][]) => vectors.map((vector) => vector.map(() => 0)),
    overflow: (vectors: number[][]) =>
        vectors.map((vector) => vector.map(() => 1e40)),
    underflow: (vectors: number[][]) =>
        vectors.map((vector) => vector.map(() => 1e-50)),
    nonfinite: (vectors: number[][]) =>
        vectors.map((vector) => vector.map(() => Infinity)),
}))
    await test(`rejects ${name} native vectors at the provider boundary`, () =>
        fixture(
            async (config) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (request, response, body) => {
                if (request.url !== '/v2/embed') return;
                response.end(
                    JSON.stringify({
                        embeddings: {
                            float: corrupt(result(body).embeddings.float),
                        },
                        secret: key,
                    })
                );
                return true;
            }
        ));

await test('query probe is mandatory and echoed text mismatches cannot silently associate another input', async () => {
    for (const mode of ['query', 'echo'])
        await fixture(
            async (config) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (request, response, body) => {
                if (
                    request.url !== '/v2/embed' ||
                    (mode === 'query' && body.input_type !== 'search_query')
                )
                    return;
                const value = result(body);
                response.end(
                    JSON.stringify(
                        mode === 'query'
                            ? { ...value, embeddings: { float: [[1, 2]] } }
                            : { ...value, texts: ['another text'] }
                    )
                );
                return true;
            }
        );
});

await test('snapshot or provider mismatches fail before embedding and do not downgrade to a default provider', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const before = requests.length;
        await assert.rejects(
            embedQuery(config, { ...identity, contextTokens: 64_000 }, 'text'),
            errorCode('MODEL_CHANGED')
        );
        await assert.rejects(
            embedQuery(config, { ...identity, digest: 'a'.repeat(64) }, 'text'),
            errorCode('MODEL_CHANGED')
        );
        const legacy: ModelIdentity = {
            schemaVersion: 1,
            provider: 'OLLAMA',
            model: 'fixture:latest',
            digest: 'a'.repeat(64),
            family: 'bert',
            architecture: 'bert',
            contextTokens: 2048,
            defaultDimensions: 3,
            dimensions: 3,
            supportedDimensions: [3],
            capabilities: ['embedding'],
            preset: 'GENERIC',
        };
        assert.deepEqual(modelIdentity.parse(legacy), legacy);
        assert.equal(embeddingIdentityKind(legacy), 'WEIGHTS_DIGEST');
        await assert.rejects(
            embedQuery(config, legacy, 'text'),
            errorCode('MODEL_CHANGED')
        );
        assert.equal(requests.length, before);
        assert.equal(
            canonicalEmbeddingModel('COHERE', 'embed-v4.0'),
            'embed-v4.0'
        );
        assert.equal(
            canonicalEmbeddingModel('OLLAMA', 'embeddinggemma'),
            'embeddinggemma:latest'
        );
        assert.throws(
            () => canonicalEmbeddingModel('UNKNOWN', 'model'),
            errorCode('INVALID_CONFIGURATION')
        );
    }));

await test('bounded input and preparation reject oversized text, blank input and oversized document arrays before embedding', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const before = requests.length;
        const limit = embeddingInputByteLimit(identity, {
            preparation: 'prefix',
        });
        for (const [text, options] of [
            ['x'.repeat(limit + 1), { preparation: 'prefix' }],
            [' ', {}],
            ['text', { preparation: 'p'.repeat(4097) }],
        ] as const)
            await assert.rejects(
                embedQuery(config, identity, text, options),
                errorCode('INPUT_TOO_LARGE')
            );
        await assert.rejects(
            embedDocuments(config, identity, []),
            errorCode('INPUT_TOO_LARGE')
        );
        await assert.rejects(
            embedDocuments(
                config,
                identity,
                Array.from({ length: 4097 }, () => ({ text: 'text' }))
            ),
            errorCode('INPUT_TOO_LARGE')
        );
        assert.equal(requests.length, before);
    }));

await test('transient retries are bounded and permanent authentication failures never expose provider text', async () => {
    let attempts = 0;
    await fixture(
        async (config) => {
            await verifyEmbeddingModel(config, selected);
            assert.equal(attempts, 4);
        },
        (request, response) => {
            if (request.url !== '/v2/embed' || ++attempts > 2) return;
            response.writeHead(attempts === 1 ? 429 : 503, {
                'Retry-After': '0',
            });
            response.end(key);
            return true;
        }
    );
    for (const status of [401, 403, 498, 503]) {
        let count = 0;
        await fixture(
            async (config) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode(
                        status === 503
                            ? 'PROVIDER_UNAVAILABLE'
                            : 'PROVIDER_REJECTED'
                    )
                );
                assert.equal(count, status === 503 ? 3 : 1);
            },
            (request, response) => {
                if (request.url !== '/v2/embed') return;
                count++;
                response.writeHead(status, { 'Retry-After': '0' });
                response.end(key);
                return true;
            }
        );
    }
});

await test('the deadline covers both probes and stalled response reads, and external aborts stay sanitized', async () => {
    await fixture(
        async (config) => {
            await assert.rejects(
                verifyEmbeddingModel(config, selected, { timeoutMs: 100 }),
                errorCode('PROVIDER_TIMEOUT')
            );
        },
        async (request, response, body) => {
            if (request.url !== '/v2/embed') return;
            if (body.input_type === 'search_document') {
                await delay(30);
                return;
            }
            response.writeHead(200);
            response.write('{"embeddings":');
            return true;
        }
    );
    await fixture(async (config, requests) => {
        const controller = new AbortController();
        controller.abort(key);
        await assert.rejects(
            discoverModels(config, { signal: controller.signal }),
            errorCode('PROVIDER_TIMEOUT')
        );
        assert.equal(requests.length, 0);
    });
});

await test('native response byte/depth/JSON limits and redirects fail closed with no response leakage', async () => {
    for (const mode of ['bytes', 'depth', 'json', 'redirect'])
        await fixture(
            async (config) => {
                await assert.rejects(
                    discoverModels(config),
                    errorCode(
                        mode === 'redirect'
                            ? 'PROVIDER_UNAVAILABLE'
                            : 'INVALID_PROVIDER_RESPONSE'
                    )
                );
            },
            (_request, response) => {
                switch (mode) {
                    case 'bytes':
                        response.writeHead(200, {
                            'Content-Length': String(9 * 1024 * 1024),
                        });
                        response.end('{}');
                        break;
                    case 'depth':
                        response.end('['.repeat(18) + '1' + ']'.repeat(18));
                        break;
                    case 'json':
                        response.end(key);
                        break;
                    default:
                        response.writeHead(302, {
                            Location: 'http://127.0.0.1:1/secret',
                        });
                        response.end();
                }
                return true;
            }
        );
});

await test('Cohere requires an explicit service root and nonempty safe key; native paths cannot cross providers', () =>
    fixture(async (config, requests) => {
        for (const endpoint of [
            `${config.endpoint}/v1`,
            `${config.endpoint}/v2`,
            `${config.endpoint}/proxy`,
            `${config.endpoint}?key=secret`,
            `${config.endpoint}#secret`,
            'ftp://127.0.0.1:1',
            'http://user:password@127.0.0.1:1',
        ])
            await assert.rejects(
                discoverModels({ ...config, endpoint }),
                errorCode('INVALID_CONFIGURATION')
            );
        for (const apiKey of [
            '',
            '  ',
            'secret\r\nInjected: value',
            'a'.repeat(8193),
        ])
            await assert.rejects(
                discoverModels({ ...config, apiKey }),
                errorCode('INVALID_CONFIGURATION')
            );
        await assert.rejects(
            requestJson(config, 'api/embed', AbortSignal.timeout(1000), {}),
            errorCode('INVALID_CONFIGURATION')
        );
        assert.equal(requests.length, 0);
    }));

await test('legitimate float32-representable values retain provider precision without normalization', () =>
    fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, selected);
            const value = await embedQuery(config, identity, 'text');
            assert.equal(value.vectors[0]?.[0], 1 / 3);
            assert.notEqual(value.vectors[0]?.[0], Math.fround(1 / 3));
        },
        (request, response, body) => {
            if (request.url !== '/v2/embed') return;
            const value = result(body);
            value.embeddings.float[0]![0] = 1 / 3;
            response.end(JSON.stringify(value));
            return true;
        }
    ));

await test('nullable usage is unknown, zero stays zero and incomplete multi-batch usage never becomes exact again', async () => {
    for (const mode of ['null', 'zero', 'incomplete', 'overflow']) {
        let calls = 0;
        await fixture(
            async (config) => {
                const identity = await verifyEmbeddingModel(config, selected);
                const operation = embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 97 }, () => ({ text: 'text' }))
                );
                if (mode === 'overflow') {
                    await assert.rejects(
                        operation,
                        errorCode('INVALID_PROVIDER_RESPONSE')
                    );
                    return;
                }
                const value = await operation;
                assert.equal(
                    value.usage.providerInputTokens,
                    mode === 'zero' ? 0 : null
                );
                assert.equal(
                    value.usage.billedInputTokens,
                    mode === 'zero' ? 0 : null
                );
                assert.equal(value.usage.requests, 2);
            },
            (request, response, body) => {
                if (request.url !== '/v2/embed') return;
                calls++;
                const value = result(body);
                const metadata =
                    mode === 'null'
                        ? { tokens: null, ['billed_units']: null }
                        : mode === 'zero'
                          ? {
                                tokens: { ['input_tokens']: 0 },
                                ['billed_units']: { ['input_tokens']: 0 },
                            }
                          : mode === 'overflow'
                            ? {
                                  tokens: {
                                      ['input_tokens']: Number.MAX_SAFE_INTEGER,
                                  },
                              }
                            : calls === 3
                              ? {
                                    tokens: { ['input_tokens']: null },
                                    ['billed_units']: { ['input_tokens']: 5 },
                                }
                              : {
                                    tokens: { ['input_tokens']: 7 },
                                    ['billed_units']: {
                                        ['input_tokens']: null,
                                    },
                                };
                response.end(
                    JSON.stringify({
                        ...value,
                        texts: mode === 'null' ? null : value.texts,
                        meta: metadata,
                    })
                );
                return true;
            }
        );
    }
});

await test('a later batch failure rejects the complete operation instead of returning earlier vectors as a partial success', () => {
    let calls = 0;
    return fixture(
        async (config, requests) => {
            const identity = await verifyEmbeddingModel(config, selected);
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 97 }, () => ({ text: 'text' }))
                ),
                errorCode('PROVIDER_UNAVAILABLE')
            );
            assert.deepEqual(
                embeddings(requests)
                    .slice(2)
                    .map((request) => request.body.texts?.length),
                [96, 1, 1, 1]
            );
        },
        (request, response) => {
            if (request.url !== '/v2/embed' || ++calls <= 3) return;
            response.writeHead(503, { 'Retry-After': '0' });
            response.end(key);
            return true;
        }
    );
});

await test('optional catalog metadata does not let unrelated incomplete entries hide supported models, and readiness still requires both probes', () =>
    fixture(
        async (config, requests) => {
            const models = await discoverModels(config);
            assert.deepEqual(
                models.map((entry) => entry.model),
                ['embed-v4.0', 'embed-multilingual-v3.0']
            );
            assert.equal(embeddings(requests).length, 0);
            const identity = await verifyEmbeddingModel(config, selected);
            assert.equal(identity.model, 'embed-v4.0');
            assert.deepEqual(
                embeddings(requests).map((request) => request.body.input_type),
                ['search_document', 'search_query']
            );
        },
        (request, response) => {
            if (!request.url?.startsWith('/v1/models')) return;
            response.end(
                JSON.stringify({
                    models: [
                        {},
                        {
                            name: null,
                            endpoints: null,
                            ['is_deprecated']: null,
                        },
                        { name: 'unrelated-hosted-model', endpoints: null },
                        {
                            name: 'embed-v4.0',
                            endpoints: null,
                            ['is_deprecated']: null,
                        },
                        { name: 'embed-english-v3.0', endpoints: ['chat'] },
                        { name: 'embed-multilingual-v3.0' },
                    ],
                })
            );
            return true;
        }
    ));

await test('invalid non-null catalog field types still fail closed without issuing an embedding probe', async () => {
    for (const model of [
        { name: 123 },
        { name: 'embed-v4.0', endpoints: 'embed' },
        { name: 'embed-v4.0', ['is_deprecated']: 'false' },
    ])
        await fixture(
            async (config, requests) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
                assert.equal(embeddings(requests).length, 0);
            },
            (_request, response) => {
                response.end(JSON.stringify({ models: [model] }));
                return true;
            }
        );
});
