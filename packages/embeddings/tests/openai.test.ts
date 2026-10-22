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
    OPENAI_MODELS,
    type OpenAIConfiguration,
    type OpenAIModelIdentity,
} from '../src/index';
import { requestJson } from '../src/http';

type Body = {
    model: string;
    input: string[];
    dimensions: number;
    encoding_format: string;
};
type Request = {
    path: string;
    method: string;
    body: Body;
    authorization?: string;
    bytes: number;
};
type Handler = (
    request: IncomingMessage,
    response: ServerResponse,
    body: Body
) => boolean | void | Promise<boolean | void>;
const key = 'private-openai-fixture-key';
const selected = {
    model: 'text-embedding-3-small',
    dimensions: 257,
    preset: 'GENERIC' as const,
};
const catalog = {
    object: 'list',
    data: [
        {
            id: 'gpt-unrelated',
            object: 'model',
            created: 1,
            ['owned_by']: 'openai',
        },
        {
            id: 'text-embedding-3-small',
            object: 'model',
            created: 1,
            ['owned_by']: 'openai',
        },
        { id: 'text-embedding-ada-002' },
        {
            id: 'text-embedding-3-large',
            object: null,
            created: null,
            ['owned_by']: null,
            ['shutdown_date']: null,
        },
    ],
};
function result(body: Body) {
    return {
        object: 'list',
        model: body.model,
        data: body.input
            .map((text, index) => ({
                object: 'embedding',
                index,
                embedding: Array.from(
                    { length: body.dimensions },
                    (_, dimension) =>
                        dimension === 0
                            ? Number(text.match(/^doc(\d+)$/)?.[1] ?? index) + 1
                            : dimension / 10_000
                ),
            }))
            .toReversed(),
        usage: {
            ['prompt_tokens']: body.input.length * 7,
            ['total_tokens']: body.input.length * 7,
        },
    };
}
async function fixture(
    run: (config: OpenAIConfiguration, requests: Request[]) => Promise<void>,
    handler?: Handler,
    basePath = '/v1'
) {
    const requests: Request[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const part of request as AsyncIterable<Uint8Array>)
            chunks.push(Buffer.from(part));
        const bytes = Buffer.concat(chunks);
        const body = bytes.length
            ? (JSON.parse(bytes.toString()) as Body)
            : ({} as Body);
        requests.push({
            path: request.url!,
            method: request.method!,
            body,
            authorization: request.headers.authorization,
            bytes: bytes.length,
        });
        if (await handler?.(request, response, body)) return;
        response.setHeader('content-type', 'application/json');
        if (request.url === `${basePath}/models` && request.method === 'GET')
            response.end(JSON.stringify(catalog));
        else if (
            request.url === `${basePath}/embeddings` &&
            request.method === 'POST'
        )
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
                provider: 'OPENAI',
                endpoint: `http://127.0.0.1:${address.port}${basePath}`,
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

await test('OpenAI authenticated native discovery intersects reviewed IDs and exposes ranges without inventing an exhaustive size list', () =>
    fixture(async (config, requests) => {
        const models = await discoverModels(config);
        assert.deepEqual(
            models.map((entry) => entry.model),
            Object.keys(OPENAI_MODELS)
        );
        assert.deepEqual(
            models.map((entry) => entry.dimensionCapability),
            [
                { kind: 'RANGE', minimum: 1, maximum: 1536, step: 1 },
                { kind: 'RANGE', minimum: 1, maximum: 3072, step: 1 },
            ]
        );
        assert.deepEqual(
            models.map((entry) => entry.defaultDimensions),
            [1536, 3072]
        );
        assert(
            models.every(
                (entry) =>
                    entry.discoverySource === 'HOSTED_CATALOG' &&
                    entry.identityKind === 'CAPABILITY_PROFILE' &&
                    entry.reviewedCatalog === undefined &&
                    entry.supportedDimensions === undefined &&
                    entry.contextTokens === 8192
            )
        );
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, 'GET');
        assert.equal(requests[0]!.path, '/v1/models');
        assert.equal(requests[0]!.authorization, `Bearer ${key}`);
        assert.equal(requests[0]!.bytes, 0);
    }));

await test('OpenAI model listing is separate from embedding readiness and failed listing is not required for a native probe', async () => {
    await fixture(
        async (config, requests) => {
            assert.equal((await discoverModels(config)).length, 2);
            await assert.rejects(
                verifyEmbeddingModel(config, selected),
                errorCode('PROVIDER_REJECTED')
            );
            assert.deepEqual(
                requests.map((entry) => entry.path),
                ['/v1/models', '/v1/embeddings']
            );
        },
        (request, response) => {
            if (request.url !== '/v1/embeddings') return;
            response.writeHead(403);
            response.end(key);
            return true;
        }
    );
    await fixture(
        async (config, requests) => {
            await assert.rejects(
                discoverModels(config),
                errorCode('PROVIDER_REJECTED')
            );
            const identity = await verifyEmbeddingModel(config, selected);
            assert.equal(identity.dimensions, 257);
            assert.deepEqual(
                requests.map((entry) => entry.path),
                ['/v1/models', '/v1/embeddings', '/v1/embeddings']
            );
        },
        (request, response) => {
            if (request.url !== '/v1/models') return;
            response.writeHead(403);
            response.end(key);
            return true;
        }
    );
});

await test('OpenAI models probe arbitrary integer reductions and natural default sizes with only the documented native fields', () =>
    fixture(async (config, requests) => {
        for (const [model, caps] of Object.entries(OPENAI_MODELS)) {
            for (const dimensions of [1, 257, caps.defaultDimensions]) {
                const identity = await verifyEmbeddingModel(config, {
                    ...selected,
                    model,
                    dimensions,
                    preparation: 'Literal {value}',
                });
                assert.equal(identity.schemaVersion, 4);
                assert.equal(identity.dimensions, dimensions);
                assert.equal(
                    identity.defaultDimensions,
                    caps.defaultDimensions
                );
                assert.deepEqual(identity.supportedDimensions, [dimensions]);
                assert.equal(
                    identity.dimensionCapability.maximum,
                    caps.maximumDimensions
                );
                assert.equal(
                    embeddingIdentityKind(identity),
                    'CAPABILITY_PROFILE'
                );
                assert.deepEqual(modelIdentity.parse(identity), identity);
                assert.match(identity.digest, /^[a-f0-9]{64}$/);
                for (const request of requests.slice(-2)) {
                    assert.equal(request.path, '/v1/embeddings');
                    assert.equal(request.authorization, `Bearer ${key}`);
                    assert.deepEqual(request.body.input, [
                        'Literal {value}\nVectorix embedding capability check.',
                    ]);
                    assert.equal(request.body.dimensions, dimensions);
                    assert.equal(request.body.encoding_format, 'float');
                    assert.deepEqual(Object.keys(request.body).toSorted(), [
                        'dimensions',
                        'encoding_format',
                        'input',
                        'model',
                    ]);
                }
            }
        }
        assert.equal(requests.length, 12);
    }));

await test('OpenAI preserves complete saved API bases and approved proxy prefixes without adding or dropping a version segment', async () => {
    for (const basePath of ['/v1', '/approved-proxy/openai/v1', '']) {
        await fixture(
            async (config, requests) => {
                for (const endpoint of [
                    config.endpoint,
                    `${config.endpoint}/`,
                ]) {
                    await discoverModels({ ...config, endpoint });
                    await verifyEmbeddingModel(
                        { ...config, endpoint },
                        selected
                    );
                }
                assert.deepEqual(
                    requests.map((entry) => entry.path),
                    [
                        `${basePath}/models`,
                        `${basePath}/embeddings`,
                        `${basePath}/embeddings`,
                        `${basePath}/models`,
                        `${basePath}/embeddings`,
                        `${basePath}/embeddings`,
                    ]
                );
            },
            undefined,
            basePath
        );
    }
});

await test('OpenAI restores indexed input ordering and keeps literal preparation, usage and native precision on document/query paths', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        const documents = await embedDocuments(config, identity, [
            { text: 'doc2', title: 'ignored title' },
            { text: 'doc0' },
            { text: 'doc1' },
        ]);
        assert.deepEqual(
            documents.vectors.map((vector) => vector[0]),
            [3, 1, 2]
        );
        assert.equal(documents.vectors[0]![1], 0.0001);
        assert.deepEqual(documents.usage, {
            providerInputTokens: 21,
            estimatedInputTokens: 3,
            requests: 1,
        });
        await embedQuery(config, identity, 'literal query', {
            preparation: 'Prefix',
        });
        assert.deepEqual(
            requests.map((entry) => entry.body.input),
            [['doc2', 'doc0', 'doc1'], ['Prefix\nliteral query']]
        );
        assert(requests.every((entry) => Object.keys(entry.body).length === 4));
    }));

await test('OpenAI rejects unknown models, noninteger/out-of-range dimensions and incompatible presets before HTTP', () =>
    fixture(async (config, requests) => {
        assert.equal(
            canonicalEmbeddingModel('OPENAI', selected.model),
            selected.model
        );
        for (const model of [
            'text-embedding-ada-002',
            'text-embedding-3-nano',
            'Text-embedding-3-small',
        ])
            await assert.rejects(
                verifyEmbeddingModel(config, { ...selected, model }),
                errorCode('MODEL_UNSUPPORTED')
            );
        for (const dimensions of [0, -1, 0.5, 1537, 3073, Number.NaN])
            await assert.rejects(
                verifyEmbeddingModel(config, { ...selected, dimensions }),
                errorCode('DIMENSIONS_UNSUPPORTED')
            );
        await assert.rejects(
            verifyEmbeddingModel(config, {
                ...selected,
                preset: 'EMBEDDING_GEMMA',
            }),
            errorCode('MODEL_UNSUPPORTED')
        );
        assert.throws(
            () =>
                canonicalEmbeddingModel('OPENAI', '../text-embedding-3-small'),
            errorCode('INVALID_CONFIGURATION')
        );
        assert.equal(requests.length, 0);
    }));

await test('OpenAI replay validates every saved capability field, exact-size hint and provider before network I/O', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const replay = modelIdentity.parse(structuredClone(identity));
        requests.length = 0;
        await embedDocuments(config, replay, [{ text: 'doc0' }]);
        for (const change of [
            { digest: '0'.repeat(64) },
            { model: 'text-embedding-3-large' },
            { defaultDimensions: 3072 },
            { dimensions: 258, supportedDimensions: [258] },
            { supportedDimensions: [257, 258] },
            {
                dimensionCapability: {
                    kind: 'RANGE',
                    minimum: 1,
                    maximum: 3072,
                    step: 1,
                },
            },
            { capabilities: ['embedding', 'invented'] },
            { retrievalRoles: 'document' },
            { truncation: false },
            { maxBatchTokens: 299_999 },
            { extra: true },
        ]) {
            const previous: number = requests.length;
            await assert.rejects(
                embedDocuments(
                    config,
                    { ...identity, ...change } as OpenAIModelIdentity,
                    [{ text: 'doc0' }]
                ),
                errorCode('MODEL_CHANGED')
            );
            assert.equal(requests.length, previous);
        }
        await assert.rejects(
            embedDocuments(
                {
                    ...config,
                    endpoint: new URL(config.endpoint).origin,
                    provider: 'COHERE',
                },
                identity,
                [{ text: 'doc0' }]
            ),
            errorCode('MODEL_CHANGED')
        );
    }));

await test('existing Ollama, Cohere and Voyage snapshot shapes still parse with their original schema and digest semantics', () => {
    const common = {
        model: 'embeddinggemma:latest',
        digest: 'a'.repeat(64),
        family: 'gemma',
        contextTokens: 2048,
        defaultDimensions: 768,
        dimensions: 256,
        supportedDimensions: [768, 512, 256, 128],
        capabilities: ['embedding'],
        preset: 'GENERIC',
    };
    const legacy = {
        ...common,
        schemaVersion: 1,
        provider: 'OLLAMA',
        architecture: 'gemma3',
    };
    assert.deepEqual(modelIdentity.parse(legacy), legacy);
    const cohere = {
        ...common,
        schemaVersion: 2,
        provider: 'COHERE',
        identityKind: 'CAPABILITY_PROFILE',
        model: 'embed-v4.0',
        family: 'cohere-embed',
        contextTokens: 128_000,
        defaultDimensions: 1536,
        supportedDimensions: [256, 512, 1024, 1536],
        documentInputType: 'search_document',
        queryInputType: 'search_query',
        embeddingType: 'float',
        truncate: 'NONE',
    };
    assert.deepEqual(modelIdentity.parse(cohere), cohere);
    const voyage = {
        ...common,
        schemaVersion: 3,
        provider: 'VOYAGE',
        identityKind: 'CAPABILITY_PROFILE',
        model: 'voyage-4',
        family: 'voyage-4',
        contextTokens: 32_000,
        defaultDimensions: 1024,
        supportedDimensions: [256, 512, 1024, 2048],
        documentInputType: 'document',
        queryInputType: 'query',
        outputDtype: 'float',
        truncation: false,
        maxBatchInputs: 1000,
        maxBatchTokens: 320_000,
    };
    assert.deepEqual(modelIdentity.parse(voyage), voyage);
});

await test('OpenAI native input-count batching stays at 2048 and preserves ordering across requests', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, {
            ...selected,
            dimensions: 1,
        });
        requests.length = 0;
        const documents = await embedDocuments(
            config,
            identity,
            Array.from({ length: 4096 }, (_, index) => ({
                text: `doc${index}`,
            }))
        );
        assert.deepEqual(
            requests.map((entry) => entry.body.input.length),
            [2048, 2048]
        );
        assert.deepEqual(
            documents.vectors.map((vector) => vector[0]),
            Array.from({ length: 4096 }, (_, index) => index + 1)
        );
        assert.equal(documents.usage.providerInputTokens, 4096 * 7);
        assert.equal(documents.usage.requests, 2);
    }));

await test('OpenAI response-aware batching keeps natural 1536/3072-dimensional workflows below the shared response ceiling', () =>
    fixture(async (config, requests) => {
        for (const [model, caps] of Object.entries(OPENAI_MODELS)) {
            const identity = await verifyEmbeddingModel(config, {
                ...selected,
                model,
                dimensions: caps.defaultDimensions,
            });
            requests.length = 0;
            const documents = await embedDocuments(
                config,
                identity,
                Array.from({ length: 180 }, () => ({ text: 'bounded' }))
            );
            const maximum = Math.floor(
                (7 * 1024 * 1024) / (caps.defaultDimensions * 32)
            );
            assert(requests.length >= 2);
            assert(
                requests.every((entry) => entry.body.input.length <= maximum)
            );
            assert.equal(documents.vectors.length, 180);
        }
    }));

await test('OpenAI aggregate admission bounds prepared bytes plus reserve and separately bounds encoded JSON', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, {
            ...selected,
            dimensions: 1,
        });
        for (const text of ['a'.repeat(8000), '\u0001'.repeat(8000)]) {
            requests.length = 0;
            await embedDocuments(
                config,
                identity,
                Array.from({ length: 90 }, () => ({ text }))
            );
            assert(requests.length >= 3);
            for (const entry of requests) {
                assert(
                    entry.body.input.reduce(
                        (sum, value) => sum + Buffer.byteLength(value) + 32,
                        0
                    ) <= 300_000
                );
                assert(entry.bytes < 1024 * 1024 + 1024);
            }
        }
    }));

await test('OpenAI per-input limits include preparation and UTF8 bytes, reject blank text and bound the total operation', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        for (const values of [
            [],
            [{ text: ' ' }],
            [{ text: 'é'.repeat(4096) }],
            Array.from({ length: 4097 }, () => ({ text: 'x' })),
        ])
            await assert.rejects(
                embedDocuments(config, identity, values),
                errorCode('INPUT_TOO_LARGE')
            );
        const budget = embeddingInputByteLimit(identity, {
            preparation: 'préface',
        });
        await assert.rejects(
            embedQuery(config, identity, 'x'.repeat(budget + 1), {
                preparation: 'préface',
            }),
            errorCode('INPUT_TOO_LARGE')
        );
        await assert.rejects(
            embedQuery(config, identity, 'x', {
                preparation: 'x'.repeat(4097),
            }),
            errorCode('INPUT_TOO_LARGE')
        );
        assert.equal(requests.length, 0);
        await embedQuery(config, identity, 'x'.repeat(budget), {
            preparation: 'préface',
        });
        assert.equal(Buffer.byteLength(requests[0]!.body.input[0]!), 8192 - 32);
    }));

await test('OpenAI prompt tokens remain separate from total tokens, estimates and absent billing, and missing input usage stays unknown', async () => {
    for (const usage of [
        undefined,
        null,
        {},
        { ['total_tokens']: 9 },
        { ['prompt_tokens']: null, ['total_tokens']: 9 },
        { ['prompt_tokens']: 3, ['total_tokens']: 9 },
    ]) {
        await fixture(
            async (config) => {
                const identity = await verifyEmbeddingModel(config, selected);
                const documents = await embedQuery(config, identity, 'query');
                assert.equal(
                    documents.usage.providerInputTokens,
                    usage?.prompt_tokens ?? null
                );
                assert.equal(documents.usage.billedInputTokens, undefined);
                assert.equal(documents.usage.estimatedInputTokens, 2);
            },
            (_request, response, body) => {
                response.end(JSON.stringify({ ...result(body), usage }));
                return true;
            }
        );
    }
});

await test('OpenAI missing usage in any successful batch propagates unknown rather than reporting a partial total', () => {
    let calls = 0;
    return fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, {
                ...selected,
                model: 'text-embedding-3-large',
                dimensions: 3072,
            });
            const documents = await embedDocuments(
                config,
                identity,
                Array.from({ length: 75 }, () => ({ text: 'q' }))
            );
            assert.equal(documents.usage.requests, 2);
            assert.equal(documents.usage.providerInputTokens, null);
        },
        (_request, response, body) => {
            if (++calls !== 4) return;
            response.end(JSON.stringify({ ...result(body), usage: null }));
            return true;
        }
    );
});

await test('OpenAI aggregation rejects integer token-count overflow across successful batches', () =>
    fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, {
                ...selected,
                model: 'text-embedding-3-large',
                dimensions: 3072,
            });
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 75 }, () => ({ text: 'q' }))
                ),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (_request, response, body) => {
            response.end(
                JSON.stringify({
                    ...result(body),
                    usage: {
                        ['prompt_tokens']: Number.MAX_SAFE_INTEGER,
                        ['total_tokens']: Number.MAX_SAFE_INTEGER,
                    },
                })
            );
            return true;
        }
    ));

await test('OpenAI malformed permutations, vector/model mismatches, non-float32 values and invalid usage fail closed', async () => {
    const mutations: ((value: ReturnType<typeof result>) => unknown)[] = [
        (value) => ({ ...value, model: 'text-embedding-3-large' }),
        (value) => ({ ...value, object: 'other' }),
        (value) => ({ ...value, data: value.data.slice(1) }),
        (value) => ({ ...value, data: [...value.data, value.data[0]] }),
        ...[0, -1, 3, 0.5].map(
            (index) => (value: ReturnType<typeof result>) => ({
                ...value,
                data: value.data.map((row) => ({ ...row, index })),
            })
        ),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, object: 'other' })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({
                ...row,
                embedding: row.embedding.slice(1),
            })),
        }),
        ...[0, 1e-100, 1e100, null].map(
            (component) => (value: ReturnType<typeof result>) => ({
                ...value,
                data: value.data.map((row) => ({
                    ...row,
                    embedding: row.embedding.map(() => component),
                })),
            })
        ),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, embedding: 'base64' })),
        }),
        ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1].map(
            (count) => (value: ReturnType<typeof result>) => ({
                ...value,
                usage: { ['prompt_tokens']: count, ['total_tokens']: count },
            })
        ),
        (value) => ({
            ...value,
            usage: { ['prompt_tokens']: 10, ['total_tokens']: 9 },
        }),
    ];
    for (const mutate of mutations) {
        let corrupt = false;
        await fixture(
            async (config) => {
                const identity = await verifyEmbeddingModel(config, selected);
                corrupt = true;
                await assert.rejects(
                    embedDocuments(config, identity, [
                        { text: 'one' },
                        { text: 'two' },
                    ]),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (_request, response, body) => {
                if (!corrupt) return;
                response.end(JSON.stringify(mutate(result(body))));
                return true;
            }
        );
    }
});

await test('OpenAI catalog rejects duplicates, invalid non-null metadata and oversized collections without probing embeddings', async () => {
    for (const value of [
        { ...catalog, data: [catalog.data[1], catalog.data[1]] },
        { ...catalog, data: [{ id: 'text-embedding-3-small', created: -1 }] },
        {
            ...catalog,
            data: [{ id: 'text-embedding-3-small', ['owned_by']: 1 }],
        },
        {
            ...catalog,
            data: [{ id: 'text-embedding-3-small', object: 'embedding' }],
        },
        {
            ...catalog,
            data: Array.from({ length: 1001 }, (_, index) => ({
                id: `unrelated${index}`,
            })),
        },
        { object: 'model', data: [] },
    ]) {
        await fixture(
            async (config, requests) => {
                await assert.rejects(
                    discoverModels(config),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
                assert.equal(requests.length, 1);
                assert.equal(requests[0]!.method, 'GET');
            },
            (_request, response) => {
                response.end(JSON.stringify(value));
                return true;
            }
        );
    }
});

await test('OpenAI configuration and fixed-path guards reject credentials in URLs, malformed secrets and unexpected methods/queries before I/O', () =>
    fixture(async (config, requests) => {
        for (const endpoint of [
            `${config.endpoint}?x=1`,
            `${config.endpoint}#fragment`,
            config.endpoint.replace('http://', 'http://user:password@'),
            'file:///v1',
        ])
            await assert.rejects(
                verifyEmbeddingModel({ ...config, endpoint }, selected),
                errorCode('INVALID_CONFIGURATION')
            );
        for (const apiKey of ['', ' ', 'bad\r\nkey', 'x'.repeat(8193)])
            await assert.rejects(
                discoverModels({ ...config, apiKey }),
                errorCode('INVALID_CONFIGURATION')
            );
        for (const path of [
            'v1/models',
            'v1/embeddings',
            'v2/embed',
            'api/embed',
        ] as const)
            await assert.rejects(
                requestJson(config, path, AbortSignal.timeout(1000), {}),
                errorCode('INVALID_CONFIGURATION')
            );
        await assert.rejects(
            requestJson(config, 'models', AbortSignal.timeout(1000), {}),
            errorCode('INVALID_CONFIGURATION')
        );
        await assert.rejects(
            requestJson(
                config,
                'models',
                AbortSignal.timeout(1000),
                undefined,
                { endpoint: 'embed' }
            ),
            errorCode('INVALID_CONFIGURATION')
        );
        await assert.rejects(
            requestJson(config, 'embeddings', AbortSignal.timeout(1000)),
            errorCode('INVALID_CONFIGURATION')
        );
        await assert.rejects(
            requestJson(
                config,
                'embeddings',
                AbortSignal.timeout(1000),
                {},
                { ['page_token']: 'x' }
            ),
            errorCode('INVALID_CONFIGURATION')
        );
        await assert.rejects(
            requestJson(config, 'embeddings', AbortSignal.timeout(1000), {
                input: 'x'.repeat(2 * 1024 * 1024),
            }),
            errorCode('INPUT_TOO_LARGE')
        );
        assert.equal(requests.length, 0);
    }));

await test('OpenAI authentication and ordinary rejection errors are sanitized without retrying or exposing provider bodies', async () => {
    for (const status of [400, 401, 403]) {
        await fixture(
            async (config, requests) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode('PROVIDER_REJECTED')
                );
                assert.equal(requests.length, 1);
            },
            (_request, response) => {
                response.writeHead(status);
                response.end(`${key}: private source/provider trace`);
                return true;
            }
        );
    }
});

await test('OpenAI transient 429/503 retries retain one deadline and issue only the fixed native request', () => {
    let calls = 0;
    return fixture(
        async (config, requests) => {
            await verifyEmbeddingModel(config, selected);
            assert.equal(requests.length, 4);
            assert(requests.every((entry) => entry.path === '/v1/embeddings'));
        },
        (_request, response) => {
            if (++calls > 2) return;
            response.writeHead(calls === 1 ? 429 : 503, { 'retry-after': '0' });
            response.end(key);
            return true;
        }
    );
});

await test('OpenAI persistent retryable failures stop after three attempts', () =>
    fixture(
        async (config, requests) => {
            await assert.rejects(
                verifyEmbeddingModel(config, selected),
                errorCode('PROVIDER_UNAVAILABLE')
            );
            assert.equal(requests.length, 3);
        },
        (_request, response) => {
            response.writeHead(503, { 'retry-after': '0' });
            response.end(key);
            return true;
        }
    ));

await test('OpenAI cancellation stops before I/O and one deadline covers both probes rather than restarting on each request', async () => {
    await fixture(
        async (config, requests) => {
            const controller = new AbortController();
            controller.abort();
            await assert.rejects(
                discoverModels(config, { signal: controller.signal }),
                errorCode('PROVIDER_TIMEOUT')
            );
            await assert.rejects(
                verifyEmbeddingModel(config, selected, {
                    signal: controller.signal,
                }),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 0);
            await assert.rejects(
                verifyEmbeddingModel(config, selected, { timeoutMs: 140 }),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert(requests.length >= 1 && requests.length <= 2);
        },
        async (_request, response, body) => {
            await delay(90);
            response.end(JSON.stringify(result(body)));
            return true;
        }
    );
});

await test('OpenAI invalid deadline values fail before provider I/O', () =>
    fixture(async (config, requests) => {
        for (const timeoutMs of [0, -1, 0.5, 300_001])
            await assert.rejects(
                verifyEmbeddingModel(config, selected, { timeoutMs }),
                errorCode('INVALID_CONFIGURATION')
            );
        assert.equal(requests.length, 0);
    }));

await test('OpenAI redirects never forward the saved credential to a different destination or path', () =>
    fixture(
        async (config, requests) => {
            await assert.rejects(
                discoverModels(config),
                errorCode('PROVIDER_UNAVAILABLE')
            );
            assert.equal(requests.length, 1);
        },
        (_request, response) => {
            response.writeHead(307, {
                location: '/outside-the-approved-prefix',
            });
            response.end();
            return true;
        }
    ));

await test('OpenAI malformed, oversized, deeply nested or invalid UTF8 responses fail within shared reader bounds', async () => {
    for (const reply of [
        (response: ServerResponse) => response.end('{broken'),
        (response: ServerResponse) => response.end(Buffer.from([0xc3, 0x28])),
        (response: ServerResponse) =>
            response.end('['.repeat(17) + '0' + ']'.repeat(17)),
        (response: ServerResponse) => {
            response.writeHead(200, {
                'content-length': String(8 * 1024 * 1024 + 1),
            });
            response.end('{}');
        },
        (response: ServerResponse) => {
            response.writeHead(200, { 'transfer-encoding': 'chunked' });
            response.write(' '.repeat(8 * 1024 * 1024));
            response.end(' ');
        },
    ]) {
        await fixture(
            async (config) => {
                await assert.rejects(
                    discoverModels(config),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (_request, response) => {
                reply(response);
                return true;
            }
        );
    }
});

await test('OpenAI a later batch failure rejects the whole operation without returning earlier vectors as partial success', () => {
    let calls = 0;
    return fixture(
        async (config, requests) => {
            const identity = await verifyEmbeddingModel(config, {
                ...selected,
                model: 'text-embedding-3-large',
                dimensions: 3072,
            });
            requests.length = 0;
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 75 }, () => ({ text: 'q' }))
                ),
                errorCode('PROVIDER_UNAVAILABLE')
            );
            assert.deepEqual(
                requests.map((entry) => entry.body.input.length),
                [74, 1, 1, 1]
            );
        },
        (_request, response) => {
            if (++calls <= 3) return;
            response.writeHead(503, { 'retry-after': '0' });
            response.end(key);
            return true;
        }
    );
});
