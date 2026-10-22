import assert from 'node:assert/strict';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import { test } from 'node:test';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { assertObservedNativeBatches } from './batch-observer-fixture';
import {
    discoverModels,
    verifyEmbeddingModel,
    embedDocuments,
    embedQuery,
    EmbeddingError,
    embeddingTitle,
    embeddingInputByteLimit,
    prepareEmbeddingInput,
    type OllamaConfiguration,
    type ModelIdentity,
    type EmbeddingBatch,
    type EmbeddingErrorCode,
} from '../src/index';

const digest = 'a'.repeat(64);
const identity: ModelIdentity = {
    schemaVersion: 1,
    provider: 'OLLAMA',
    model: 'fixture:latest',
    digest,
    family: 'bert',
    architecture: 'bert',
    contextTokens: 2048,
    defaultDimensions: 3,
    dimensions: 3,
    supportedDimensions: [3],
    capabilities: ['embedding'],
    preset: 'GENERIC',
};
type Body = {
    model?: string;
    input?: string[];
    dimensions?: number;
    truncate?: boolean;
};
async function fixture(
    run: (
        config: OllamaConfiguration,
        requests: { path: string; body: Body; authorization?: string }[]
    ) => Promise<void>,
    handler?: (
        request: IncomingMessage,
        response: ServerResponse,
        body: Body
    ) => boolean | void
) {
    const requests: { path: string; body: Body; authorization?: string }[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const value of request) chunks.push(Buffer.from(value));
        const body = chunks.length
            ? (JSON.parse(Buffer.concat(chunks).toString()) as Body)
            : {};
        requests.push({
            path: request.url!,
            body,
            authorization: request.headers.authorization,
        });
        if (handler?.(request, response, body)) return;
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/tags')
            response.end(
                JSON.stringify({
                    models: [
                        {
                            name: identity.model,
                            model: identity.model,
                            digest,
                            details: { family: 'bert' },
                        },
                    ],
                })
            );
        else if (request.url === '/api/show')
            response.end(
                JSON.stringify({
                    details: { family: 'bert' },
                    capabilities: ['embedding'],
                    ['model_info']: {
                        'general.architecture': 'bert',
                        'bert.context_length': 2048,
                        'bert.embedding_length': 3,
                    },
                })
            );
        else
            response.end(
                JSON.stringify({
                    model: identity.model,
                    embeddings: body.input?.map(() => [0.2, 0.3, 0.4]),
                    ['prompt_eval_count']: body.input!.length * 5,
                })
            );
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    assert(address && typeof address !== 'string');
    try {
        await run(
            {
                provider: 'OLLAMA',
                endpoint: `http://127.0.0.1:${address.port}`,
                apiKey: 'test-private-key',
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
    !error.message.includes('test-private-key');

await test('discovers installed canonical model manifests and probes actual dimensions', () =>
    fixture(async (config, requests) => {
        assert.deepEqual(await discoverModels(config), [
            { model: identity.model, digest, family: 'bert' },
        ]);
        const verified = await verifyEmbeddingModel(config, {
            model: 'fixture',
            dimensions: 3,
            preset: 'GENERIC',
        });
        assert.deepEqual(verified, identity);
        assert(
            requests.every(
                (request) => request.authorization === 'Bearer test-private-key'
            )
        );
        assert.equal(
            requests.find((request) => request.path === '/api/embed')?.body
                .truncate,
            false
        );
    }));
await test('generic input is raw, literal preparation is shared, query and document semantics differ explicitly', () =>
    fixture(async (config, requests) => {
        await embedDocuments(
            config,
            identity,
            [{ text: 'Bonjour', title: 'Ignored for GENERIC' }],
            { preparation: 'literal {text}' }
        );
        await embedQuery(config, identity, 'Hello', {
            preparation: 'literal {text}',
        });
        assert.deepEqual(
            requests
                .filter((request) => request.path === '/api/embed')
                .map((request) => request.body.input),
            [['literal {text}\nBonjour'], ['literal {text}\nHello']]
        );
        const gemma = { ...identity, preset: 'EMBEDDING_GEMMA' as const };
        assert.equal(
            prepareEmbeddingInput(gemma, 'document', 'Texte', {
                title: ' A\nB ',
                preparation: 'Prep',
            }),
            'Prep\ntitle: A B | text: Texte'
        );
        assert.equal(
            prepareEmbeddingInput(gemma, 'query', 'Question', {
                preparation: 'Prep',
            }),
            'Prep\ntask: search result | query: Question'
        );
        assert.equal(
            prepareEmbeddingInput(gemma, 'document', 'Texte'),
            'title: none | text: Texte'
        );
    }));
await test('batches at 128, keeps order, and aggregates separately labeled usage', () =>
    fixture(async (config, requests) => {
        const result = await embedDocuments(
            config,
            identity,
            Array.from({ length: 129 }, (_, index) => ({
                text: `Passage ${index}`,
            }))
        );
        assert.equal(result.vectors.length, 129);
        assert.equal(result.usage.providerInputTokens, 645);
        assert.equal(result.usage.requests, 2);
        assert(result.usage.estimatedInputTokens > 0);
        assert.deepEqual(
            requests
                .filter((request) => request.path === '/api/embed')
                .map((request) => request.body.input?.length),
            [128, 1]
        );
        assert.deepEqual(
            requests.map((request) => request.path),
            [
                '/api/tags',
                '/api/embed',
                '/api/tags',
                '/api/tags',
                '/api/embed',
                '/api/tags',
            ]
        );
    }));
await test('missing provider token counts are null rather than fabricated exact values', () =>
    fixture(
        async (config) => {
            const result = await embedQuery(config, identity, 'text');
            assert.equal(result.usage.providerInputTokens, null);
        },
        (request, response) => {
            if (request.url !== '/api/embed') return;
            response.end(
                JSON.stringify({
                    model: identity.model,
                    embeddings: [[1, 2, 3]],
                })
            );
            return true;
        }
    ));
for (const [name, vectors] of Object.entries({
    zero: [[0, 0, 0]],
    float32Overflow: [[1e40, 1, 1]],
    float32Underflow: [[1e-50, -1e-50, 0]],
    wrongDimensions: [[1, 2]],
    wrongCount: [
        [1, 2, 3],
        [1, 2, 3],
    ],
    nonfinite: [[Number.POSITIVE_INFINITY, 2, 3]],
})) {
    await test(`rejects ${name} vectors without exposing provider payloads`, () =>
        fixture(
            async (config) => {
                await assert.rejects(
                    embedQuery(config, identity, 'text'),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (request, response) => {
                if (request.url !== '/api/embed') return;
                response.end(
                    JSON.stringify({
                        model: identity.model,
                        embeddings: vectors,
                        secret: 'test-private-key',
                    })
                );
                return true;
            }
        ));
}
await test('rejects model replacement before embedding and after native response', async () => {
    await fixture(async (config, requests) => {
        await assert.rejects(
            embedQuery(config, { ...identity, digest: 'b'.repeat(64) }, 'text'),
            errorCode('MODEL_CHANGED')
        );
        assert.equal(
            requests.filter((request) => request.path === '/api/embed').length,
            0
        );
    });
    let checks = 0;
    await fixture(
        async (config) => {
            await assert.rejects(
                embedQuery(config, identity, 'text'),
                errorCode('MODEL_CHANGED')
            );
        },
        (request, response) => {
            if (request.url !== '/api/tags' || ++checks === 1) return;
            response.end(
                JSON.stringify({
                    models: [{ name: identity.model, digest: 'b'.repeat(64) }],
                })
            );
            return true;
        }
    );
});
await test('retries only transient status with bounded attempts, never exposing bodies', async () => {
    let attempts = 0;
    await fixture(
        async (config) => {
            assert.equal(
                (await embedQuery(config, identity, 'text')).vectors.length,
                1
            );
            assert.equal(attempts, 3);
        },
        (request, response) => {
            if (request.url !== '/api/embed' || ++attempts === 3) return;
            response.writeHead(attempts === 1 ? 429 : 503, {
                'Retry-After': '0',
            });
            response.end('secret test-private-key');
            return true;
        }
    );
    await fixture(
        async (config, requests) => {
            await assert.rejects(
                embedQuery(config, identity, 'text'),
                errorCode('PROVIDER_REJECTED')
            );
            assert.equal(requests.length, 2);
        },
        (request, response) => {
            if (request.url !== '/api/embed') return;
            response.writeHead(401);
            response.end('secret test-private-key');
            return true;
        }
    );
});
await test('shared operation deadline aborts a stalled body and retries', () =>
    fixture(
        async (config) => {
            await assert.rejects(
                embedQuery(config, identity, 'text', { timeoutMs: 50 }),
                errorCode('PROVIDER_TIMEOUT')
            );
        },
        (request, response) => {
            if (request.url !== '/api/embed') return;
            response.writeHead(200);
            response.write('{"model":');
            return true;
        }
    ));
await test('external cancellation is sanitized', () =>
    fixture(async (config) => {
        const controller = new AbortController();
        controller.abort('test-private-key');
        await assert.rejects(
            discoverModels(config, { signal: controller.signal }),
            errorCode('PROVIDER_TIMEOUT')
        );
    }));
await test('response size, nesting, malformed JSON, and redirects fail closed', async () => {
    for (const mode of ['size', 'depth', 'json', 'redirect']) {
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
                    case 'size':
                        response.writeHead(200, {
                            'Content-Length': String(9 * 1024 * 1024),
                        });
                        response.end('{}');
                        break;
                    case 'depth':
                        response.end('['.repeat(18) + '1' + ']'.repeat(18));
                        break;
                    case 'json':
                        response.end('secret test-private-key');
                        break;
                    default:
                        response.writeHead(302, {
                            location: 'http://localhost:1/secret',
                        });
                        response.end();
                        break;
                }
                return true;
            }
        );
    }
});
await test('unsupported models, unverified reductions and inferred presets fail', () =>
    fixture(async (config) => {
        await assert.rejects(
            verifyEmbeddingModel(config, {
                model: 'fixture',
                dimensions: 2,
                preset: 'GENERIC',
            }),
            errorCode('DIMENSIONS_UNSUPPORTED')
        );
        await assert.rejects(
            verifyEmbeddingModel(config, {
                model: 'fixture',
                dimensions: 3,
                preset: 'EMBEDDING_GEMMA',
            }),
            errorCode('MODEL_UNSUPPORTED')
        );
        await assert.rejects(
            verifyEmbeddingModel(config, {
                model: 'absent',
                dimensions: 3,
                preset: 'GENERIC',
            }),
            errorCode('MODEL_NOT_FOUND')
        );
    }));
await test('UTF-8 safe title and context budgets include every input prefix and margin', () => {
    const title = embeddingTitle('😀'.repeat(100));
    assert.equal(Buffer.byteLength(title), 200);
    assert.equal([...title].length, 50);
    const gemma = { ...identity, preset: 'EMBEDDING_GEMMA' as const };
    const limit = embeddingInputByteLimit(gemma, {
        title,
        preparation: 'Préparation',
    });
    const text = prepareEmbeddingInput(gemma, 'document', 'x'.repeat(limit), {
        title,
        preparation: 'Préparation',
    });
    assert.equal(Buffer.byteLength(text), identity.contextTokens - 32);
    assert.throws(
        () =>
            prepareEmbeddingInput(gemma, 'document', 'x'.repeat(limit + 1), {
                title,
                preparation: 'Préparation',
            }),
        errorCode('INPUT_TOO_LARGE')
    );
    assert.throws(
        () =>
            prepareEmbeddingInput(
                gemma,
                'query',
                'é'.repeat(identity.contextTokens)
            ),
        errorCode('INPUT_TOO_LARGE')
    );
});

await test('native capability and exact dimension probes reject unsupported or ignored requests', async () => {
    await fixture(
        async (config) => {
            await assert.rejects(
                verifyEmbeddingModel(config, {
                    model: 'fixture',
                    dimensions: 3,
                    preset: 'GENERIC',
                }),
                errorCode('MODEL_UNSUPPORTED')
            );
        },
        (request, response) => {
            if (request.url !== '/api/show') return;
            response.end(
                JSON.stringify({
                    details: { family: 'bert' },
                    capabilities: ['completion'],
                    ['model_info']: {
                        'general.architecture': 'bert',
                        'bert.context_length': 2048,
                        'bert.embedding_length': 3,
                    },
                })
            );
            return true;
        }
    );
    await fixture(
        async (config) => {
            await assert.rejects(
                verifyEmbeddingModel(config, {
                    model: 'fixture',
                    dimensions: 3,
                    preset: 'GENERIC',
                }),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (request, response) => {
            if (request.url !== '/api/embed') return;
            response.end(
                JSON.stringify({ model: identity.model, embeddings: [[1, 2]] })
            );
            return true;
        }
    );
});
await test('bounds streamed response bytes independently from content length and bounds transient attempts', async () => {
    await fixture(
        async (config) => {
            await assert.rejects(
                discoverModels(config),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (_request, response) => {
            response.writeHead(200);
            response.end(' '.repeat(8 * 1024 * 1024 + 1));
            return true;
        }
    );
    let attempts = 0;
    await fixture(
        async (config) => {
            await assert.rejects(
                discoverModels(config),
                errorCode('PROVIDER_UNAVAILABLE')
            );
            assert.equal(attempts, 3);
        },
        (_request, response) => {
            attempts++;
            response.writeHead(503, { 'Retry-After': '0' });
            response.end('test-private-key');
            return true;
        }
    );
});
await test('rejects credential-bearing destinations and header injection before network access', async () => {
    for (const endpoint of [
        'ftp://127.0.0.1:1',
        'http://user:password@127.0.0.1:1',
        'http://127.0.0.1:1/?key=private',
        'http://127.0.0.1:1/#private',
    ])
        await assert.rejects(
            discoverModels({ provider: 'OLLAMA', endpoint, apiKey: null }),
            errorCode('INVALID_CONFIGURATION')
        );
    await assert.rejects(
        discoverModels({
            provider: 'OLLAMA',
            endpoint: 'http://127.0.0.1:1',
            apiKey: 'secret\r\nInjected: value',
        }),
        errorCode('INVALID_CONFIGURATION')
    );
});

await test('legitimate float32-representable provider values preserve their returned precision', () =>
    fixture(
        async (config) => {
            const result = await embedQuery(config, identity, 'text');
            assert.deepEqual(result.vectors, [[1 / 3, 0.2, 1e-50]]);
            assert.notEqual(result.vectors[0]?.[0], Math.fround(1 / 3));
        },
        (request, response) => {
            if (request.url !== '/api/embed') return;
            response.end(
                JSON.stringify({
                    model: identity.model,
                    embeddings: [[1 / 3, 0.2, 1e-50]],
                })
            );
            return true;
        }
    ));

await test('Ollama awaits observer checkpoints for each normalized native batch', () =>
    fixture(async (config) => {
        await assertObservedNativeBatches(
            config,
            identity,
            Array.from({ length: 129 }, (_, index) => ({ text: `doc${index}` }))
        );
    }));

await test('awaited before-batch approval prevents native I/O and after data cannot mutate the returned vectors', () =>
    fixture(async (config, requests) => {
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let metadata: EmbeddingBatch | undefined;
        const pending = embedQuery(
            config,
            identity,
            'private-canonical-input',
            {
                preparation: 'literal preparation',
                batchObserver: {
                    async beforeBatch(batch) {
                        metadata = batch;
                        entered.resolve();
                        await release.promise;
                    },
                    afterBatch(_batch, result) {
                        assert.equal(result.usage.providerInputTokens, 5);
                        result.vectors[0]![0] = 12_345;
                        result.usage.providerInputTokens = -1;
                    },
                },
            }
        );
        try {
            await Promise.race([
                entered.promise,
                pending.then(() =>
                    assert.fail('Approval must occur before completion.')
                ),
            ]);
            assert.equal(requests.length, 0);
            assert(metadata);
            assert.equal(metadata.kind, 'query');
            assert(
                !JSON.stringify(metadata).includes('private-canonical-input')
            );
            assert(!JSON.stringify(metadata).includes('literal preparation'));
        } finally {
            release.resolve();
        }
        const result = await pending;
        assert.deepEqual(result.vectors, [[0.2, 0.3, 0.4]]);
        assert.equal(result.usage.providerInputTokens, 5);
    }));

await test('a before-batch refusal performs no native I/O or completion/failure callback', () =>
    fixture(async (config, requests) => {
        const refusal = new Error('Caller refused the reservation.');
        let otherHooks = 0;
        await assert.rejects(
            embedQuery(config, identity, 'text', {
                batchObserver: {
                    beforeBatch() {
                        throw refusal;
                    },
                    afterBatch() {
                        otherHooks++;
                    },
                    failedBatch() {
                        otherHooks++;
                    },
                },
            }),
            (error: unknown) => error === refusal
        );
        assert.equal(requests.length, 0);
        assert.equal(otherHooks, 0);
    }));

await test('completed native-batch usage survives a later failure and failed-hook errors preserve the native error', () => {
    let embeds = 0;
    return fixture(
        async (config) => {
            const completed: number[] = [];
            const failures: {
                metadata: EmbeddingBatch;
                code: EmbeddingErrorCode;
            }[] = [];
            await assert.rejects(
                embedDocuments(
                    config,
                    identity,
                    Array.from({ length: 129 }, (_, index) => ({
                        text: `doc${index}`,
                    })),
                    {
                        batchObserver: {
                            async afterBatch(metadata, result) {
                                await Promise.resolve();
                                assert.equal(metadata.inputOffset, 0);
                                assert.equal(result.vectors.length, 128);
                                completed.push(
                                    result.usage.providerInputTokens!
                                );
                            },
                            failedBatch(metadata, code) {
                                failures.push({ metadata, code });
                                throw new Error(
                                    'Caller checkpoint storage is unavailable.'
                                );
                            },
                        },
                    }
                ),
                errorCode('PROVIDER_REJECTED')
            );
            assert.deepEqual(completed, [640]);
            assert.equal(failures.length, 1);
            assert.equal(failures[0]!.metadata.ordinal, 1);
            assert.equal(failures[0]!.metadata.inputOffset, 128);
            assert.equal(failures[0]!.metadata.inputCount, 1);
            assert.equal(failures[0]!.code, 'PROVIDER_REJECTED');
            assert(!JSON.stringify(failures).includes('private-provider-body'));
        },
        (request, response) => {
            if (request.url !== '/api/embed' || ++embeds !== 2) return;
            response.writeHead(400);
            response.end(JSON.stringify({ error: 'private-provider-body' }));
            return true;
        }
    );
});

await test('invalid native vectors produce only a sanitized failure event, never a completed checkpoint', () =>
    fixture(
        async (config) => {
            let after = 0;
            const failures: EmbeddingErrorCode[] = [];
            await assert.rejects(
                embedQuery(config, identity, 'text', {
                    batchObserver: {
                        afterBatch() {
                            after++;
                        },
                        failedBatch(_metadata, code) {
                            failures.push(code);
                        },
                    },
                }),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
            assert.equal(after, 0);
            assert.deepEqual(failures, ['INVALID_PROVIDER_RESPONSE']);
        },
        (request, response) => {
            if (request.url !== '/api/embed') return;
            response.end(
                JSON.stringify({
                    model: identity.model,
                    embeddings: [[0.1, 0.2]],
                    error: 'private-provider-body',
                })
            );
            return true;
        }
    ));

await test('an after-batch checkpoint failure stops later native batches without reclassifying validated success', () =>
    fixture(async (config, requests) => {
        const checkpointFailure = new Error('Durable checkpoint failed.');
        let failed = 0;
        await assert.rejects(
            embedDocuments(
                config,
                identity,
                Array.from({ length: 129 }, (_, index) => ({
                    text: `doc${index}`,
                })),
                {
                    batchObserver: {
                        afterBatch() {
                            throw checkpointFailure;
                        },
                        failedBatch() {
                            failed++;
                        },
                    },
                }
            ),
            (error: unknown) => error === checkpointFailure
        );
        assert.equal(
            requests.filter((request) => request.path === '/api/embed').length,
            1
        );
        assert.equal(failed, 0);
    }));

await test('transport retries remain one observed logical batch and one successful usage request', () => {
    let embeds = 0;
    return fixture(
        async (config) => {
            let before = 0,
                after = 0,
                failed = 0;
            const result = await embedQuery(config, identity, 'text', {
                batchObserver: {
                    beforeBatch() {
                        before++;
                    },
                    afterBatch() {
                        after++;
                    },
                    failedBatch() {
                        failed++;
                    },
                },
            });
            assert.deepEqual(
                { before, after, failed, wireAttempts: embeds },
                { before: 1, after: 1, failed: 0, wireAttempts: 3 }
            );
            assert.equal(result.usage.requests, 1);
        },
        (request, response) => {
            if (request.url !== '/api/embed' || ++embeds > 2) return;
            response.writeHead(503);
            response.end('private-transient-provider-body');
            return true;
        }
    );
});

await test('before-batch waiting consumes the existing operation deadline without dispatching', () =>
    fixture(async (config, requests) => {
        const failures: EmbeddingErrorCode[] = [];
        await assert.rejects(
            embedQuery(config, identity, 'text', {
                timeoutMs: 5,
                batchObserver: {
                    async beforeBatch() {
                        await delay(20);
                    },
                    failedBatch(_metadata, code) {
                        failures.push(code);
                    },
                },
            }),
            errorCode('PROVIDER_TIMEOUT')
        );
        assert.equal(requests.length, 0);
        assert.deepEqual(failures, ['PROVIDER_TIMEOUT']);
    }));

await test('validated usage can finish its awaited checkpoint after caller cancellation', () =>
    fixture(async (config) => {
        const controller = new AbortController();
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        let persistedAfterCancellation = false;
        const pending = embedQuery(config, identity, 'text', {
            signal: controller.signal,
            batchObserver: {
                async afterBatch(_metadata, result) {
                    entered.resolve();
                    await release.promise;
                    assert.equal(result.usage.providerInputTokens, 5);
                    persistedAfterCancellation = controller.signal.aborted;
                },
            },
        });
        try {
            await Promise.race([
                entered.promise,
                pending.then(() => assert.fail('Checkpoint must be awaited.')),
            ]);
            controller.abort();
        } finally {
            release.resolve();
        }
        assert.equal((await pending).usage.requests, 1);
        assert.equal(persistedAfterCancellation, true);
    }));

await test('prepared-input hashes are ordered, framed, preparation-sensitive and deterministic', () =>
    fixture(async (config) => {
        const hashes: string[] = [];
        for (const [texts, preparation] of [
            [['a', 'bc'], ''],
            [['ab', 'c'], ''],
            [['a', 'bc'], ''],
            [['bc', 'a'], ''],
            [['a', 'bc'], 'prefix'],
        ] as const) {
            await embedDocuments(
                config,
                identity,
                texts.map((text) => ({ text })),
                {
                    preparation,
                    batchObserver: {
                        beforeBatch(metadata) {
                            hashes.push(metadata.preparedInputHash);
                        },
                    },
                }
            );
        }
        assert.notEqual(hashes[0], hashes[1]);
        assert.equal(hashes[0], hashes[2]);
        assert.notEqual(hashes[0], hashes[3]);
        assert.notEqual(hashes[0], hashes[4]);
    }));
