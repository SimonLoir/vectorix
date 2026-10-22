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
    VOYAGE_MODELS,
    type VoyageConfiguration,
    type VoyageModelIdentity,
} from '../src/index';
import { requestJson } from '../src/http';

type Body = {
    model: string;
    input: string[];
    input_type: string;
    output_dimension: number;
    output_dtype: string;
    truncation: boolean;
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
const key = 'private-voyage-fixture-key';
const selected = {
    model: 'voyage-4',
    dimensions: 256,
    preset: 'GENERIC' as const,
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
                    { length: body.output_dimension },
                    (_, dimension) =>
                        dimension === 0
                            ? Number(text.match(/^doc(\d+)$/)?.[1] ?? index) + 1
                            : dimension / 10_000
                ),
            }))
            .toReversed(),
        usage: { ['total_tokens']: body.input.length * 7 },
    };
}
async function fixture(
    run: (config: VoyageConfiguration, requests: Request[]) => Promise<void>,
    handler?: Handler
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
            body,
            authorization: request.headers.authorization,
            bytes: bytes.length,
        });
        if (await handler?.(request, response, body)) return;
        response.setHeader('content-type', 'application/json');
        if (request.url === '/v1/embeddings')
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
                provider: 'VOYAGE',
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

await test('Voyage discovery is a reviewed bounded local catalog, without HTTP or credential-readiness claims', () =>
    fixture(async (config, requests) => {
        const models = await discoverModels({
            ...config,
            apiKey: 'syntactically-valid-but-unverified',
        });
        assert.deepEqual(
            models.map((entry) => entry.model),
            ['voyage-4', 'voyage-4-lite', 'voyage-4-large']
        );
        assert(
            models.every(
                (entry) =>
                    entry.reviewedCatalog === true &&
                    entry.discoverySource === undefined
            )
        );
        for (const entry of models) {
            assert.equal(entry.identityKind, 'CAPABILITY_PROFILE');
            assert.deepEqual(entry.supportedDimensions, [256, 512, 1024, 2048]);
            assert.equal(entry.defaultDimensions, 1024);
            assert.equal(entry.contextTokens, 32_000);
            assert.match(entry.digest, /^[a-f0-9]{64}$/);
        }
        assert.equal(requests.length, 0);
        assert.equal(
            (
                await discoverModels({
                    ...config,
                    endpoint: 'http://127.0.0.1:1',
                })
            ).length,
            3
        );
    }));

await test('all reviewed Voyage models and sizes probe both native retrieval roles without invented prompts', () =>
    fixture(async (config, requests) => {
        for (const model of Object.keys(VOYAGE_MODELS)) {
            for (const dimensions of [256, 512, 1024, 2048]) {
                const identity = await verifyEmbeddingModel(config, {
                    ...selected,
                    model,
                    dimensions,
                    preparation: 'Literal {value}',
                });
                assert.equal(identity.schemaVersion, 3);
                assert.equal(identity.model, model);
                assert.equal(identity.dimensions, dimensions);
                assert.equal(
                    identity.maxBatchTokens,
                    VOYAGE_MODELS[model as keyof typeof VOYAGE_MODELS]
                        .maxBatchTokens
                );
                assert.equal(
                    embeddingIdentityKind(identity),
                    'CAPABILITY_PROFILE'
                );
                assert.deepEqual(modelIdentity.parse(identity), identity);
                const probes = requests.slice(-2);
                assert.deepEqual(
                    probes.map((entry) => entry.body.input_type),
                    ['document', 'query']
                );
                for (const probe of probes) {
                    assert.equal(probe.path, '/v1/embeddings');
                    assert.equal(probe.authorization, `Bearer ${key}`);
                    assert.deepEqual(probe.body.input, [
                        'Literal {value}\nVectorix embedding capability check.',
                    ]);
                    assert.equal(probe.body.truncation, false);
                    assert.equal(probe.body.output_dtype, 'float');
                    assert.equal(probe.body.output_dimension, dimensions);
                    assert.deepEqual(Object.keys(probe.body).toSorted(), [
                        'input',
                        'input_type',
                        'model',
                        'output_dimension',
                        'output_dtype',
                        'truncation',
                    ]);
                }
            }
        }
        assert.equal(requests.length, 24);
    }));

await test('indexed Voyage response vectors are restored to input order and preserve native roles and numeric precision', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        const documents = await embedDocuments(config, identity, [
            { text: 'doc2', title: 'ignored' },
            { text: 'doc0' },
            { text: 'doc1' },
        ]);
        assert.deepEqual(
            documents.vectors.map((entry) => entry[0]),
            [3, 1, 2]
        );
        assert.equal(documents.vectors[0]![1], 0.0001);
        assert.equal(documents.usage.providerInputTokens, 21);
        assert.equal(documents.usage.billedInputTokens, undefined);
        assert.equal(documents.usage.requests, 1);
        assert.equal(documents.usage.estimatedInputTokens, 3);
        await embedQuery(config, identity, 'literal query', {
            preparation: 'Prefix',
        });
        assert.deepEqual(
            requests.map((entry) => entry.body.input_type),
            ['document', 'query']
        );
        assert.deepEqual(requests[0]!.body.input, ['doc2', 'doc0', 'doc1']);
        assert.deepEqual(requests[1]!.body.input, ['Prefix\nliteral query']);
    }));

await test('Voyage IDs stay exact; unknown models, dimensions and incompatible presets fail before HTTP', () =>
    fixture(async (config, requests) => {
        assert.equal(canonicalEmbeddingModel('VOYAGE', 'voyage-4'), 'voyage-4');
        for (const model of [
            'voyage-3',
            'voyage-4-nano',
            'voyage-code-4',
            'Voyage-4',
        ])
            await assert.rejects(
                verifyEmbeddingModel(config, { ...selected, model }),
                errorCode('MODEL_UNSUPPORTED')
            );
        await assert.rejects(
            verifyEmbeddingModel(config, { ...selected, dimensions: 768 }),
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
            () => canonicalEmbeddingModel('VOYAGE', '../voyage-4'),
            errorCode('INVALID_CONFIGURATION')
        );
        assert.equal(requests.length, 0);
    }));

await test('complete immutable Voyage native capability snapshots reject changed semantics before replay I/O', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        const replay = modelIdentity.parse(structuredClone(identity));
        requests.length = 0;
        await embedDocuments(config, replay, [{ text: 'doc0' }]);
        assert.equal(requests.length, 1);
        for (const change of [
            { digest: '0'.repeat(64) },
            { maxBatchTokens: 120_000 },
            { supportedDimensions: [256, 512, 2048, 1024] },
            { capabilities: ['embedding'] },
            { model: 'voyage-4-lite' },
            { dimensions: 512 },
        ]) {
            const previous: number = requests.length;
            await assert.rejects(
                embedDocuments(
                    config,
                    { ...identity, ...change } as VoyageModelIdentity,
                    [{ text: 'doc0' }]
                ),
                errorCode('MODEL_CHANGED')
            );
            assert.equal(requests.length, previous);
        }
        await assert.rejects(
            embedDocuments({ ...config, provider: 'COHERE' }, identity, [
                { text: 'doc0' },
            ]),
            errorCode('MODEL_CHANGED')
        );
    }));

await test('Voyage batching respects the native 1000-input limit and restores ordering across smaller safe request boundaries', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        const documents = await embedDocuments(
            config,
            identity,
            Array.from({ length: 2005 }, (_, index) => ({
                text: `doc${index}`,
            }))
        );
        assert.deepEqual(
            requests.map((entry) => entry.body.input.length),
            [896, 896, 213]
        );
        assert.deepEqual(
            documents.vectors.map((entry) => entry[0]),
            Array.from({ length: 2005 }, (_, index) => index + 1)
        );
        assert.equal(documents.usage.providerInputTokens, 2005 * 7);
        assert.equal(documents.usage.requests, 3);
        assert(requests.every((entry) => entry.bytes < 2 * 1024 * 1024));
    }));

await test('Voyage per-model aggregate admission uses prepared bytes plus role reserve, with request JSON bounded separately', () =>
    fixture(async (config, requests) => {
        for (const model of Object.keys(VOYAGE_MODELS)) {
            const identity = await verifyEmbeddingModel(config, {
                ...selected,
                model,
            });
            requests.length = 0;
            await embedDocuments(
                config,
                identity,
                Array.from({ length: 35 }, () => ({ text: 'a'.repeat(31_000) }))
            );
            assert(requests.length >= 2);
            for (const entry of requests) {
                const bound = entry.body.input.reduce(
                    (sum, text) => sum + Buffer.byteLength(text) + 64,
                    0
                );
                assert(bound <= identity.maxBatchTokens);
                assert(entry.bytes < 1024 * 1024 + 1024);
                assert.equal(entry.body.truncation, false);
            }
        }
        const identity = await verifyEmbeddingModel(config, {
            ...selected,
            model: 'voyage-4-lite',
        });
        requests.length = 0;
        await embedDocuments(
            config,
            identity,
            Array.from({ length: 35 }, () => ({ text: '"\\\n'.repeat(10_000) }))
        );
        assert(requests.length > 1);
        assert(requests.every((entry) => entry.bytes < 1024 * 1024 + 1024));
    }));

await test('Voyage response-budget batching shrinks large vector outputs below the shared JSON ceiling', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, {
            ...selected,
            dimensions: 2048,
        });
        requests.length = 0;
        const docs = await embedDocuments(
            config,
            identity,
            Array.from({ length: 180 }, () => ({ text: 'bounded' }))
        );
        assert(requests.length >= 2);
        assert(
            requests.every(
                (entry) =>
                    entry.body.input.length <=
                    Math.floor((7 * 1024 * 1024) / (2048 * 32))
            )
        );
        assert.equal(docs.vectors.length, 180);
    }));

await test('Voyage input limits include literal preparation and reject empty or excessive arrays before provider calls', () =>
    fixture(async (config, requests) => {
        const identity = await verifyEmbeddingModel(config, selected);
        requests.length = 0;
        for (const values of [
            [],
            [{ text: ' ' }],
            Array.from({ length: 4097 }, () => ({ text: 'x' })),
            [{ text: 'a'.repeat(32_000) }],
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
    }));

await test('Voyage missing usage is explicitly unknown; reported total tokens remain distinct from estimates', () => {
    let missing = false;
    let missingBatch = 0;
    return fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, selected);
            const counted = await embedQuery(config, identity, 'query');
            assert.equal(counted.usage.providerInputTokens, 7);
            assert.equal(counted.usage.estimatedInputTokens, 2);
            missing = true;
            const unknown = await embedDocuments(
                config,
                identity,
                Array.from({ length: 1001 }, () => ({ text: 'q' }))
            );
            assert.equal(unknown.usage.providerInputTokens, null);
            assert.equal(unknown.usage.billedInputTokens, undefined);
        },
        (_request, response, body) => {
            if (!missing) return;
            const value: unknown = {
                ...result(body),
                usage:
                    ++missingBatch > 1 ? undefined : { ['total_tokens']: 10 },
            };
            response.end(JSON.stringify(value));
            return true;
        }
    );
});

await test('Voyage malformed index permutations, count/model mismatches and incompatible vector responses fail closed', async () => {
    const mutations: ((value: ReturnType<typeof result>) => unknown)[] = [
        (value) => ({ ...value, model: 'voyage-4-lite' }),
        (value) => ({ ...value, data: value.data.slice(1) }),
        (value) => ({ ...value, data: [...value.data, value.data[0]] }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, index: 0 })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, index: -1 })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, index: 3 })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, index: 0.5 })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({
                ...row,
                embedding: row.embedding.slice(1),
            })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({
                ...row,
                embedding: row.embedding.map(() => 0),
            })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({
                ...row,
                embedding: row.embedding.map(() => 1e-100),
            })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({
                ...row,
                embedding: row.embedding.map(() => 1e100),
            })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({
                ...row,
                embedding: row.embedding.map(() => null),
            })),
        }),
        (value) => ({
            ...value,
            data: value.data.map((row) => ({ ...row, embedding: 'base64' })),
        }),
        (value) => ({ ...value, usage: { ['total_tokens']: -1 } }),
        (value) => ({ ...value, usage: { ['total_tokens']: 0.5 } }),
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

await test('Voyage total token aggregation rejects safe-integer overflow across successful batches', () => {
    let excessive = false;
    return fixture(
        async (config) => {
            const identity = await verifyEmbeddingModel(config, selected);
            excessive = true;
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 1001 }, () => ({ text: 'q' }))
                ),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (_request, response, body) => {
            if (!excessive) return;
            response.end(
                JSON.stringify({
                    ...result(body),
                    usage: { ['total_tokens']: Number.MAX_SAFE_INTEGER },
                })
            );
            return true;
        }
    );
});

await test('Voyage native route allowlist rejects path confusion and versioned/credential-bearing base URLs before HTTP', () =>
    fixture(async (config, requests) => {
        for (const endpoint of [
            `${config.endpoint}/v1`,
            `${config.endpoint}/proxy`,
            `${config.endpoint}?x=1`,
            `${config.endpoint}#fragment`,
            config.endpoint.replace('http://', 'http://user:password@'),
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
        for (const path of ['v1/models', 'v2/embed', 'api/embed'] as const)
            await assert.rejects(
                requestJson(config, path, AbortSignal.timeout(1000), {}),
                errorCode('INVALID_CONFIGURATION')
            );
        await assert.rejects(
            requestJson(config, 'v1/embeddings', AbortSignal.timeout(1000)),
            errorCode('INVALID_CONFIGURATION')
        );
        await assert.rejects(
            requestJson(
                config,
                'v1/embeddings',
                AbortSignal.timeout(1000),
                {},
                { endpoint: 'embed' }
            ),
            errorCode('INVALID_CONFIGURATION')
        );
        assert.equal(requests.length, 0);
    }));

await test('Voyage provider errors are sanitized and authentication rejection is never retried', () =>
    fixture(
        async (config, requests) => {
            await assert.rejects(
                verifyEmbeddingModel(config, selected),
                errorCode('PROVIDER_REJECTED')
            );
            assert.equal(requests.length, 1);
        },
        (_request, response) => {
            response.writeHead(401);
            response.end(
                JSON.stringify({
                    detail: `${key}: private document/provider trace`,
                })
            );
            return true;
        }
    ));

await test('Voyage transient retries are bounded and share one operation deadline', () => {
    let calls = 0;
    return fixture(
        async (config, requests) => {
            const identity = await verifyEmbeddingModel(config, selected);
            assert.equal(identity.provider, 'VOYAGE');
            assert.equal(requests.length, 4);
        },
        (_request, response) => {
            if (++calls > 2) return;
            response.writeHead(calls === 1 ? 429 : 503, { 'retry-after': '0' });
            response.end('private retry detail');
            return true;
        }
    );
});

await test('Voyage persistent retryable failures stop after three attempts', () =>
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

await test('Voyage cancellation and timeout stop bounded native probes and do not claim discovery readiness', async () => {
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
                verifyEmbeddingModel(config, selected, { timeoutMs: 20 }),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert(requests.length <= 1);
        },
        async (_request, response) => {
            await delay(60);
            response.end('{}');
            return true;
        }
    );
});

await test('Voyage redirects never forward the bound credential to another native path', () =>
    fixture(
        async (config, requests) => {
            await assert.rejects(
                verifyEmbeddingModel(config, selected),
                errorCode('PROVIDER_UNAVAILABLE')
            );
            assert.equal(requests.length, 1);
        },
        (_request, response) => {
            response.writeHead(307, { location: '/other' });
            response.end();
            return true;
        }
    ));

await test('Voyage multi-batch work shares one deadline rather than granting a fresh timeout to each batch', () => {
    let slow = false;
    return fixture(
        async (config, requests) => {
            const identity = await verifyEmbeddingModel(config, selected);
            requests.length = 0;
            slow = true;
            const startedAt = Date.now();
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 1001 }, () => ({ text: 'q' })),
                    { timeoutMs: 60 }
                ),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert(requests.length <= 2);
            assert(Date.now() - startedAt < 1000);
        },
        async (_request, _response) => {
            if (slow) await delay(40);
        }
    );
});

await test('Voyage response byte/depth/JSON limits reject hostile provider responses without exposing their content', async () => {
    for (const body of [
        'x'.repeat(8 * 1024 * 1024 + 1),
        '['.repeat(18) + '0' + ']'.repeat(18),
        '{broken-json',
    ]) {
        await fixture(
            async (config) => {
                await assert.rejects(
                    verifyEmbeddingModel(config, selected),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (_request, response) => {
                response.end(body);
                return true;
            }
        );
    }
});
