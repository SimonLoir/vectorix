import assert from 'node:assert/strict';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { assertObservedNativeBatches } from './batch-observer-fixture';
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
    MISTRAL_MODELS,
    type MistralConfiguration,
    type MistralModelIdentity,
} from '../src/index';
import { requestJson } from '../src/http';

type Body = { model: string; input: string[]; encoding_format: string };
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
const key = 'private-mistral-fixture-key';
const selected = {
    model: 'mistral-embed',
    dimensions: 1024,
    preset: 'GENERIC' as const,
};
const catalog = {
    object: 'list',
    data: [
        {
            id: 'mistral-embed-2312',
            object: 'model',
            aliases: ['mistral-embed', 'unknown-alias'],
            ['max_context_length']: 8192,
            capabilities: {},
        },
        {
            id: 'unreviewed-chat-model',
            aliases: ['fake-embedding-model'],
            capabilities: { ['completion_chat']: true },
        },
    ],
};
function result(body: Body, responseModel = 'mistral-embed-2312') {
    return {
        object: 'list',
        model: responseModel,
        data: body.input
            .map((text, index) => ({
                object: 'embedding',
                index,
                embedding: Array.from({ length: 1024 }, (_, dimension) =>
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
    run: (config: MistralConfiguration, requests: Request[]) => Promise<void>,
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
                provider: 'MISTRAL',
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

await test('Mistral native catalog intersects explicit reviewed IDs and aliases without requiring an invented embeddings capability', () =>
    fixture(async (config, requests) => {
        const models = await discoverModels(config);
        assert.deepEqual(
            models.map((entry) => entry.model),
            Object.keys(MISTRAL_MODELS)
        );
        assert(
            models.every(
                (entry) =>
                    entry.discoverySource === 'HOSTED_CATALOG' &&
                    entry.identityKind === 'CAPABILITY_PROFILE' &&
                    entry.reviewedCatalog === undefined &&
                    entry.dimensionCapability === undefined &&
                    entry.contextTokens === 8000
            )
        );
        for (const model of models) {
            assert.equal(model.defaultDimensions, 1024);
            assert.deepEqual(model.supportedDimensions, [1024]);
        }
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, 'GET');
        assert.equal(requests[0]!.authorization, `Bearer ${key}`);
        assert.equal(requests[0]!.bytes, 0);
    }));

await test('Mistral unsupported model cards cannot enable a reviewed alias and arbitrary alias names never become executable', async () => {
    for (const data of [
        [
            {
                id: 'unreviewed-chat',
                aliases: ['mistral-embed', 'mistral-embed-2312'],
            },
        ],
        [
            {
                id: 'mistral-embed-2312',
                aliases: ['unknown-alias', 'mistral-embed-latest'],
            },
        ],
        [{ id: 'mistral-embed', aliases: null }],
    ]) {
        await fixture(
            async (config, requests) => {
                const models = await discoverModels(config);
                assert.deepEqual(
                    models.map((entry) => entry.model),
                    data[0]!.id === 'unreviewed-chat' ? [] : [data[0]!.id]
                );
                assert.equal(requests.length, 1);
            },
            (_request, response) => {
                response.end(JSON.stringify({ object: 'list', data }));
                return true;
            }
        );
    }
});

await test('both Mistral requested aliases permit either stable reviewed response ID and probe only fixed native float fields', async () => {
    for (const model of Object.keys(MISTRAL_MODELS)) {
        for (const responseModel of Object.keys(MISTRAL_MODELS)) {
            await fixture(
                async (config, requests) => {
                    const identity = await verifyEmbeddingModel(config, {
                        ...selected,
                        model,
                        preparation: 'Literal {value}',
                    });
                    assert.equal(identity.schemaVersion, 5);
                    assert.equal(identity.model, model);
                    assert.equal(identity.responseModel, responseModel);
                    assert.deepEqual(identity.equivalentModels, [
                        'mistral-embed',
                        'mistral-embed-2312',
                    ]);
                    assert.deepEqual(modelIdentity.parse(identity), identity);
                    assert.equal(
                        embeddingIdentityKind(identity),
                        'CAPABILITY_PROFILE'
                    );
                    assert.equal(identity.contextTokens, 8000);
                    assert.deepEqual(identity.supportedDimensions, [1024]);
                    assert.deepEqual(identity.batchPolicy, {
                        maxInputs: 64,
                        maxPreparedInputBytes: 16_000,
                        inputTokenReserve: 32,
                    });
                    assert.equal(requests.length, 2);
                    for (const request of requests) {
                        assert.equal(request.method, 'POST');
                        assert.equal(request.path, '/v1/embeddings');
                        assert.equal(request.body.model, model);
                        assert.equal(request.body.encoding_format, 'float');
                        assert.deepEqual(request.body.input, [
                            'Literal {value}\nVectorix embedding capability check.',
                        ]);
                        assert.deepEqual(Object.keys(request.body).toSorted(), [
                            'encoding_format',
                            'input',
                            'model',
                        ]);
                    }
                },
                (_request, response, body) => {
                    response.end(JSON.stringify(result(body, responseModel)));
                    return true;
                }
            );
        }
    }
});

await test('Mistral rejects response-alias drift between native probes and never creates an identity from a mixed observation', () => {
    let calls = 0;
    return fixture(
        async (config, requests) => {
            await assert.rejects(
                verifyEmbeddingModel(config, selected),
                errorCode('MODEL_CHANGED')
            );
            assert.equal(requests.length, 2);
        },
        (_request, response, body) => {
            response.end(
                JSON.stringify(
                    result(
                        body,
                        ++calls === 1 ? 'mistral-embed-2312' : 'mistral-embed'
                    )
                )
            );
            return true;
        }
    );
});

await test('Mistral replay requires the saved response alias and rejects both valid-pair drift and an unreviewed provider ID', () => {
    let responseModel = 'mistral-embed-2312';
    return fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, selected);
            await embedQuery(config, identity, 'query');
            responseModel = 'mistral-embed';
            await assert.rejects(
                embedQuery(config, identity, 'query'),
                errorCode('MODEL_CHANGED')
            );
            responseModel = 'mistral-embed-new';
            await assert.rejects(
                embedQuery(config, identity, 'query'),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (_request, response, body) => {
            response.end(JSON.stringify(result(body, responseModel)));
            return true;
        }
    );
});

await test('Mistral complete immutable snapshots reject altered alias-equivalence, processing policy and observed model before replay I/O', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const replay = modelIdentity.parse(structuredClone(identity));
        requests.length = 0;
        await embedDocuments(config, replay, [{ text: 'doc0' }]);
        for (const change of [
            { digest: '0'.repeat(64) },
            { model: 'mistral-embed-2312' },
            { responseModel: 'mistral-embed' },
            { equivalentModels: ['mistral-embed-2312', 'mistral-embed'] },
            { supportedDimensions: [1024, 1024] },
            { contextTokens: 8192 },
            { dimensions: 512 },
            { capabilities: ['embedding', 'invented'] },
            {
                batchPolicy: {
                    maxInputs: 128,
                    maxPreparedInputBytes: 16_000,
                    inputTokenReserve: 32,
                },
            },
            { extra: true },
        ]) {
            const previous: number = requests.length;
            await assert.rejects(
                embedDocuments(
                    config,
                    { ...identity, ...change } as MistralModelIdentity,
                    [{ text: 'doc0' }]
                ),
                errorCode('MODEL_CHANGED')
            );
            assert.equal(requests.length, previous);
        }
        await assert.rejects(
            embedDocuments({ ...config, provider: 'OPENAI' }, identity, [
                { text: 'doc0' },
            ]),
            errorCode('MODEL_CHANGED')
        );
    }));

await test('Mistral preserves the complete saved API base including approved prefixes and optional trailing slash', async () => {
    for (const basePath of ['/v1', '/approved-proxy/mistral/v1', '']) {
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

await test('Mistral rejects unknown native IDs, attempted dimension reductions and inferred presets before provider I/O', () =>
    fixture(async (config, requests) => {
        assert.equal(
            canonicalEmbeddingModel('MISTRAL', 'mistral-embed'),
            'mistral-embed'
        );
        for (const model of [
            'mistral-embed-new',
            'codestral-embed',
            'Mistral-embed',
        ])
            await assert.rejects(
                verifyEmbeddingModel(config, { ...selected, model }),
                errorCode('MODEL_UNSUPPORTED')
            );
        for (const dimensions of [0, 1, 512, 1023, 1025, Number.NaN])
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
            () => canonicalEmbeddingModel('MISTRAL', '../mistral-embed'),
            errorCode('INVALID_CONFIGURATION')
        );
        assert.equal(requests.length, 0);
    }));

await test('Mistral batches at the internal 64-input ceiling and restores indexed ordering across requests without inventing native roles', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        const documents = await embedDocuments(
            config,
            identity,
            Array.from({ length: 130 }, (_, index) => ({
                text: `doc${index}`,
                title: 'ignored',
            }))
        );
        assert.deepEqual(
            requests.map((entry) => entry.body.input.length),
            [64, 64, 2]
        );
        assert.deepEqual(
            documents.vectors.map((entry) => entry[0]),
            Array.from({ length: 130 }, (_, index) => index + 1)
        );
        assert.equal(documents.vectors[0]![1], 0.0001);
        assert.deepEqual(documents.usage, {
            providerInputTokens: 130 * 7,
            estimatedInputTokens: 250,
            requests: 3,
        });
        await embedQuery(config, identity, 'literal query', {
            preparation: 'Prefix',
        });
        assert.deepEqual(requests.at(-1)!.body.input, [
            'Prefix\nliteral query',
        ]);
        assert(requests.every((entry) => Object.keys(entry.body).length === 3));
    }));

await test('Mistral prepared-byte admission includes 32 reserved units per input and accepts exactly the 16000 boundary', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        await embedDocuments(config, identity, [
            { text: 'a'.repeat(7968) },
            { text: 'b'.repeat(7968) },
            { text: 'c' },
        ]);
        assert.deepEqual(
            requests.map((entry) => entry.body.input.length),
            [2, 1]
        );
        assert.equal(
            requests[0]!.body.input.reduce(
                (sum, text) => sum + Buffer.byteLength(text) + 32,
                0
            ),
            16_000
        );
        requests.length = 0;
        await embedDocuments(
            config,
            identity,
            Array.from({ length: 4 }, () => ({ text: 'é'.repeat(1980) })),
            { preparation: 'Literal prefix' }
        );
        assert(requests.length > 1);
        assert(
            requests.every(
                (entry) =>
                    entry.body.input.reduce(
                        (sum, text) => sum + Buffer.byteLength(text) + 32,
                        0
                    ) <= 16_000
            )
        );
    }));

await test('Mistral conservative input budget includes preparation, UTF8 and operation bounds without silently truncating', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        for (const values of [
            [],
            [{ text: ' ' }],
            [{ text: 'é'.repeat(4000) }],
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
        assert.equal(Buffer.byteLength(requests[0]!.body.input[0]!), 8000 - 32);
    }));

await test('Mistral usage reports prompt tokens only and missing usage never becomes total tokens, billing or a zero estimate', async () => {
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
                const query = await embedQuery(config, identity, 'query');
                assert.equal(
                    query.usage.providerInputTokens,
                    usage?.prompt_tokens ?? null
                );
                assert.equal(query.usage.billedInputTokens, undefined);
                assert.equal(query.usage.estimatedInputTokens, 2);
            },
            (_request, response, body) => {
                response.end(JSON.stringify({ ...result(body), usage }));
                return true;
            }
        );
    }
});

await test('Mistral usage is unknown if any batch omits prompt tokens and aggregate overflow fails explicitly', async () => {
    for (const overflow of [false, true]) {
        let calls = 0;
        await fixture(
            async (config) => {
                const identity = await verifyEmbeddingModel(config, selected);
                const work = embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 65 }, () => ({ text: 'q' }))
                );
                if (overflow)
                    await assert.rejects(
                        work,
                        errorCode('INVALID_PROVIDER_RESPONSE')
                    );
                else assert.equal((await work).usage.providerInputTokens, null);
            },
            (_request, response, body) => {
                const usage = overflow
                    ? {
                          ['prompt_tokens']: Number.MAX_SAFE_INTEGER,
                          ['total_tokens']: Number.MAX_SAFE_INTEGER,
                      }
                    : ++calls === 4
                      ? null
                      : result(body).usage;
                response.end(JSON.stringify({ ...result(body), usage }));
                return true;
            }
        );
    }
});

await test('Mistral malformed index permutations, model/vector envelopes, float32 values and usage fail closed', async () => {
    const mutations: ((value: ReturnType<typeof result>) => unknown)[] = [
        (value) => ({ ...value, model: 'unknown-embedding-model' }),
        (value) => ({ ...value, object: 123 }),
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
            data: value.data.map((row) => ({ ...row, object: 123 })),
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

await test('Mistral documented catalog defaults accept omitted envelope fields, empty listings and optional model-card metadata', async () => {
    for (const value of [
        {},
        { object: 'list' },
        { data: [] },
        { object: 'native-model-catalog', data: [] },
        { data: [{ id: 'mistral-embed-2312', aliases: ['mistral-embed'] }] },
        {
            object: 'list',
            data: [
                {
                    id: 'mistral-embed-2312',
                    object: 'native-model-card',
                    aliases: ['mistral-embed'],
                    created: null,
                    ['owned_by']: null,
                    ['max_context_length']: null,
                },
            ],
        },
    ]) {
        await fixture(
            async (config, requests) => {
                const models = await discoverModels(config);
                assert.deepEqual(
                    models.map((entry) => entry.model),
                    'data' in value && value.data?.length
                        ? ['mistral-embed', 'mistral-embed-2312']
                        : []
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

await test('Mistral defaultable catalog fields still reject invalid present types without enabling aliases or making probes', async () => {
    for (const value of [
        { object: null },
        { object: 1 },
        { object: [] },
        { data: null },
        { data: {} },
        { data: 'models' },
        { data: [{ id: 'mistral-embed', object: 1 }] },
        { data: [{ id: 'mistral-embed', created: 'yesterday' }] },
        { data: [{ id: 'mistral-embed', ['owned_by']: 1 }] },
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

await test('Mistral native embedding responses accept omitted cosmetic row objects and bounded string metadata while preserving indexed vectors', () =>
    fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, selected);
            assert.equal(identity.responseModel, 'mistral-embed-2312');
            const documents = await embedDocuments(config, identity, [
                { text: 'doc2' },
                { text: 'doc0' },
                { text: 'doc1' },
            ]);
            assert.deepEqual(
                documents.vectors.map((entry) => entry[0]),
                [3, 1, 2]
            );
        },
        (_request, response, body) => {
            const value = result(body);
            response.end(
                JSON.stringify({
                    ...value,
                    object: 'native-embedding-list',
                    data: value.data.map((row, index) => ({
                        ...row,
                        object:
                            index % 2 === 0
                                ? undefined
                                : 'native-embedding-row',
                    })),
                })
            );
            return true;
        }
    ));

await test('Mistral useful row fields remain mandatory even for one input and optional cosmetic objects reject invalid present types', async () => {
    for (const change of [
        { index: undefined },
        { embedding: undefined },
        { object: null },
        { object: 1 },
        { object: [] },
    ]) {
        await fixture(
            async (config) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (_request, response, body) => {
                const value = result(body);
                response.end(
                    JSON.stringify({
                        ...value,
                        data: value.data.map((row) => ({ ...row, ...change })),
                    })
                );
                return true;
            }
        );
    }
});

await test('Mistral catalog metadata and alias arrays are bounded and duplicate IDs fail without embedding probes', async () => {
    for (const data of [
        [catalog.data[0], catalog.data[0]],
        [{ id: 'mistral-embed', aliases: 'mistral-embed-2312' }],
        [{ id: 'mistral-embed', aliases: [1] }],
        [
            {
                id: 'mistral-embed',
                aliases: Array.from({ length: 101 }, () => 'alias'),
            },
        ],
        [{ id: 'mistral-embed', ['max_context_length']: -1 }],
        Array.from({ length: 1001 }, (_, index) => ({
            id: `unrelated${index}`,
        })),
    ]) {
        await fixture(
            async (config, requests) => {
                await assert.rejects(
                    discoverModels(config),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
                assert.equal(requests.length, 1);
            },
            (_request, response) => {
                response.end(JSON.stringify({ object: 'list', data }));
                return true;
            }
        );
    }
});

await test('Mistral a later response-alias drift rejects the entire multi-batch result without returning partial success', () => {
    let calls = 0;
    return fixture(
        async (config, requests) => {
            const identity = await verifyEmbeddingModel(config, selected);
            requests.length = 0;
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 65 }, () => ({ text: 'q' }))
                ),
                errorCode('MODEL_CHANGED')
            );
            assert.deepEqual(
                requests.map((entry) => entry.body.input.length),
                [64, 1]
            );
        },
        (_request, response, body) => {
            response.end(
                JSON.stringify(
                    result(
                        body,
                        ++calls > 3 ? 'mistral-embed' : 'mistral-embed-2312'
                    )
                )
            );
            return true;
        }
    );
});

await test('Mistral configuration and fixed-path guards reject credentials in URLs, malformed secrets and unexpected methods/queries before I/O', () =>
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

await test('Mistral authentication and ordinary rejection errors are sanitized without retrying or exposing provider bodies', async () => {
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

await test('Mistral transient 429/503 retries retain one deadline and issue only the fixed native request', () => {
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

await test('Mistral persistent retryable failures stop after three attempts', () =>
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

await test('Mistral cancellation stops before I/O and one deadline covers both probes rather than restarting on each request', async () => {
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

await test('Mistral invalid deadline values fail before provider I/O', () =>
    fixture(async (config, requests) => {
        for (const timeoutMs of [0, -1, 0.5, 300_001])
            await assert.rejects(
                verifyEmbeddingModel(config, selected, { timeoutMs }),
                errorCode('INVALID_CONFIGURATION')
            );
        assert.equal(requests.length, 0);
    }));

await test('Mistral redirects never forward the saved credential to a different destination or path', () =>
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

await test('Mistral malformed, oversized, deeply nested or invalid UTF8 responses fail within shared reader bounds', async () => {
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

await test('Mistral awaits observer checkpoints for each normalized native batch', () =>
    fixture(async (config) => {
        const identity = await verifyEmbeddingModel(config, selected);
        await assertObservedNativeBatches(
            config,
            identity,
            Array.from({ length: 3 }, (_, index) => ({
                text: `doc${index} ` + 'a'.repeat(5990),
            }))
        );
    }));
