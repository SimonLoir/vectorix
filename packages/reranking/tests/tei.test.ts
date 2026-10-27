import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    rerank,
    probeTei,
    parseTeiRuntimeSnapshot,
    validateRerankingInput,
    type RerankingConfiguration,
} from '../src/index';
import {
    isRerankingModelId,
    supportsRerankingModel,
    rerankingScoreKind,
    listRerankingModels,
} from '../src/models';
import { errorCode, key } from './fixture';
import { parseTeiInfo } from '../src/tei-snapshot';
import {
    teiFixture,
    teiInfo,
    teiInput,
    teiModel,
    teiResults,
    teiSnapshot,
} from './tei-fixture';

await test('TEI model choices are suggestions; custom bounded deployment labels require native model binding', () => {
    assert.deepEqual(
        listRerankingModels('TEI').map((entry) => entry.id),
        [
            'BAAI/bge-reranker-v2-m3',
            'Alibaba-NLP/gte-multilingual-reranker-base',
        ]
    );
    for (const label of [
        teiModel,
        '/data/reranker',
        'local/model@revision',
        'x'.repeat(200),
    ]) {
        assert(isRerankingModelId(label));
        assert(supportsRerankingModel('TEI', label));
        assert.equal(supportsRerankingModel('COHERE', label), false);
    }
    for (const value of [
        '',
        'x'.repeat(201),
        ' model',
        'model name',
        'x\n',
        'x\u0000',
        'x\u007F',
        'x\u2028y',
        null,
    ])
        assert.equal(isRerankingModelId(value), false);
    assert.equal(rerankingScoreKind('TEI'), 'normalized_cross_encoder');
    assert.equal(rerankingScoreKind('COHERE'), 'provider_relevance');
    assert.equal(rerankingScoreKind('VOYAGE'), 'provider_relevance');
});

await test('native metadata and saved snapshots share public persistence bounds without clamping reported limits', () => {
    for (const limits of [
        { maxInputLength: 1, maxClientBatchSize: 1 },
        { maxInputLength: 10_000_000, maxClientBatchSize: 100_000 },
    ]) {
        const saved = parseTeiRuntimeSnapshot({
            ...teiSnapshot,
            ...limits,
            modelRevision: 'r'.repeat(128),
            runtimeVersion: 'v'.repeat(64),
        });
        const live = parseTeiInfo(
            teiInfo({
                ['max_input_length']: limits.maxInputLength,
                ['max_client_batch_size']: limits.maxClientBatchSize,
                ['model_sha']: 'r'.repeat(128),
                version: 'v'.repeat(64),
            })
        );
        assert.deepEqual(live, saved);
        assert.equal(live.maxInputLength, limits.maxInputLength);
        assert.equal(live.maxClientBatchSize, limits.maxClientBatchSize);
    }

    const invalid = [
        ['maxInputLength', 'max_input_length', 0],
        ['maxInputLength', 'max_input_length', 10_000_001],
        ['maxInputLength', 'max_input_length', 1.5],
        ['maxClientBatchSize', 'max_client_batch_size', 0],
        ['maxClientBatchSize', 'max_client_batch_size', 100_001],
        ['maxClientBatchSize', 'max_client_batch_size', 1.5],
        ['modelRevision', 'model_sha', ''],
        ['modelRevision', 'model_sha', 'r'.repeat(129)],
        ['modelRevision', 'model_sha', 'bad revision'],
        ['runtimeVersion', 'version', ''],
        ['runtimeVersion', 'version', 'v'.repeat(65)],
    ] as const;
    for (const [savedField, liveField, value] of invalid) {
        assert.throws(
            () =>
                parseTeiRuntimeSnapshot({
                    ...teiSnapshot,
                    [savedField]: value,
                }),
            errorCode('INVALID_CONFIGURATION')
        );
        assert.throws(
            () => parseTeiInfo(teiInfo({ [liveField]: value })),
            errorCode('INVALID_PROVIDER_RESPONSE')
        );
    }
});

await test('probe performs one authenticated metadata GET and returns an immutable reported-only snapshot', () =>
    teiFixture(async (configuration, requests) => {
        const snapshot = await probeTei(configuration, {
            model: teiModel,
            candidatePool: 32,
        });
        assert.deepEqual(snapshot, teiSnapshot);
        assert(Object.isFrozen(snapshot));
        assert.deepEqual(
            Object.keys(snapshot).toSorted(),
            Object.keys(teiSnapshot).toSorted()
        );
        assert.equal(snapshot.modelRevision, null);
        assert.equal('weightsDigest' in snapshot, false);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.method, 'GET');
        assert.equal(requests[0]!.path, '/info');
        assert.equal(requests[0]!.authorization, `Bearer ${key}`);
        assert.equal(requests[0]!.bytes, 0);
    }));

for (const apiKey of [undefined, null]) {
    await test('a private keyless TEI deployment receives no synthetic Authorization header', () =>
        teiFixture(async (configuration, requests) => {
            const connection = { ...configuration, apiKey };
            await probeTei(connection, { model: teiModel, candidatePool: 3 });
            const result = await rerank(
                { ...connection, runtimeSnapshot: teiSnapshot },
                teiInput
            );
            assert.equal(result.results.length, 3);
            assert.equal(requests.length, 3);
            assert(
                requests.every((request) => request.authorization === undefined)
            );
        }));
}

await test('one live info check precedes one exact native POST with normalized complete indexed scores', () =>
    teiFixture(async (configuration, requests) => {
        const result = await rerank(
            { ...configuration, runtimeSnapshot: teiSnapshot },
            teiInput
        );
        assert.deepEqual(
            requests.map((request) => [request.method, request.path]),
            [
                ['GET', '/info'],
                ['POST', '/rerank'],
            ]
        );
        assert(
            requests.every(
                (request) => request.authorization === `Bearer ${key}`
            )
        );
        assert.deepEqual(requests[1]!.body, {
            query: teiInput.query,
            texts: teiInput.documents,
            truncate: false,
            ['raw_scores']: false,
            ['return_text']: false,
        });
        assert.equal('model' in requests[1]!.body, false);
        assert.deepEqual(result.results, [
            { index: 1, score: 0.8 },
            { index: 0, score: 0.5 },
            { index: 2, score: 0.5 },
        ]);
        assert.deepEqual(result.usage, {
            providerInputTokens: null,
            billedInputTokens: null,
            billedSearchUnits: null,
        });
        assert.equal(
            'scoreKind' in result,
            false,
            'Legacy result shape remains unchanged; new public mappers add score interpretation explicitly.'
        );
    }));

for (const revision of [null, 'main', 'a'.repeat(40)]) {
    await test(`reported revision ${String(revision)} is compared as metadata without being promoted to weight verification`, () =>
        teiFixture(
            async (configuration) => {
                const saved = parseTeiRuntimeSnapshot({
                    ...teiSnapshot,
                    modelRevision: revision,
                });
                assert.equal(saved.modelRevision, revision);
                assert(Object.isFrozen(saved));
                await rerank(
                    { ...configuration, runtimeSnapshot: saved },
                    teiInput
                );
            },
            (response, request) =>
                response.end(
                    JSON.stringify(
                        request.path === '/info'
                            ? teiInfo({ ['model_sha']: revision })
                            : teiResults()
                    )
                )
        ));
}

const changed = [
    { ['model_id']: 'different/model' },
    { ['model_sha']: 'different-revision' },
    { ['max_input_length']: 4096 },
    { ['max_client_batch_size']: 64 },
    { ['model_dtype']: 'float16' },
    { version: '1.10.0' },
];
for (const metadata of changed) {
    await test('changed live model identity, revision or execution limits refuse before inference', () =>
        teiFixture(
            async (configuration, requests) => {
                await assert.rejects(
                    rerank(
                        { ...configuration, runtimeSnapshot: teiSnapshot },
                        teiInput
                    ),
                    errorCode('MODEL_CHANGED')
                );
                assert.equal(requests.length, 1);
                assert.equal(requests[0]!.method, 'GET');
            },
            (response) => response.end(JSON.stringify(teiInfo(metadata)))
        ));
}

await test('the server candidate limit is enforced at probe and before a rerank POST, without split requests', () =>
    teiFixture(async (configuration, requests) => {
        await assert.rejects(
            probeTei(configuration, { model: teiModel, candidatePool: 33 }),
            errorCode('INPUT_TOO_LARGE')
        );
        await assert.rejects(
            rerank(
                { ...configuration, runtimeSnapshot: teiSnapshot },
                {
                    ...teiInput,
                    documents: Array.from({ length: 33 }, () => 'text'),
                }
            ),
            errorCode('INPUT_TOO_LARGE')
        );
        assert.equal(
            requests.length,
            1,
            'Saved batch overflow must fail before even the metadata GET.'
        );
    }));

await test('live TEI permits must fit the whole candidate pool without changing its saved client-batch limit', () =>
    teiFixture(
        async (configuration, requests) => {
            await assert.rejects(
                probeTei(configuration, { model: teiModel, candidatePool: 8 }),
                errorCode('INPUT_TOO_LARGE')
            );
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    {
                        ...teiInput,
                        documents: Array.from({ length: 8 }, () => 'text'),
                    }
                ),
                errorCode('INPUT_TOO_LARGE')
            );
            assert.deepEqual(
                requests.map((request) => request.method),
                ['GET', 'GET']
            );
            const snapshot = await probeTei(configuration, {
                model: teiModel,
                candidatePool: 4,
            });
            assert.equal(snapshot.maxClientBatchSize, 32);
            assert.equal('maxConcurrentRequests' in snapshot, false);
            const result = await rerank(
                { ...configuration, runtimeSnapshot: snapshot },
                {
                    ...teiInput,
                    documents: Array.from({ length: 4 }, () => 'text'),
                }
            );
            assert.equal(result.results.length, 4);
            assert.deepEqual(
                requests.map((request) => request.method),
                ['GET', 'GET', 'GET', 'GET', 'POST']
            );
        },
        (response, request) =>
            response.end(
                JSON.stringify(
                    request.path === '/info'
                        ? teiInfo({ ['max_concurrent_requests']: 4 })
                        : teiResults((request.body.texts as string[]).length)
                )
            )
    ));

for (const metadata of [
    { ['model_type']: { embedding: { pooling: 'mean' } } },
    {
        ['model_type']: {
            reranker: {
                ['id2label']: { '0': 'a', '1': 'b' },
                ['label2id']: { a: 0, b: 1 },
            },
        },
    },
    { ['max_input_length']: 0 },
    { ['max_client_batch_size']: -1 },
    { ['max_client_batch_size']: '32' },
    { ['max_concurrent_requests']: undefined },
    { ['max_concurrent_requests']: 0 },
    { ['max_concurrent_requests']: 100_001 },
    { ['max_concurrent_requests']: '32' },
    { ['model_id']: 'bad\nmodel' },
    { version: '' },
]) {
    await test('malformed or non-reranker metadata is a sanitized refusal with no inference', () =>
        teiFixture(
            async (configuration, requests) => {
                await assert.rejects(
                    probeTei(configuration, {
                        model: teiModel,
                        candidatePool: 3,
                    }),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
                assert.equal(requests.length, 1);
            },
            (response) => response.end(JSON.stringify(teiInfo(metadata)))
        ));
}

await test('saved snapshots are strict and validated before any external work', () =>
    teiFixture(async (configuration, requests) => {
        for (const saved of [
            null,
            {},
            { ...teiSnapshot, protocolVersion: 'unsupported' },
            { ...teiSnapshot, modelRevision: undefined },
            { ...teiSnapshot, weightsDigest: 'fake' },
            { ...teiSnapshot, maxInputLength: 0 },
        ]) {
            assert.throws(
                () => parseTeiRuntimeSnapshot(saved),
                errorCode('INVALID_CONFIGURATION')
            );
            await assert.rejects(
                rerank(
                    {
                        ...configuration,
                        runtimeSnapshot: saved,
                    } as unknown as RerankingConfiguration,
                    teiInput
                ),
                errorCode('INVALID_CONFIGURATION')
            );
        }
        await assert.rejects(
            rerank(
                { ...configuration, runtimeSnapshot: teiSnapshot },
                { ...teiInput, model: 'another-model' }
            ),
            errorCode('MODEL_CHANGED')
        );
        assert.equal(requests.length, 0);
    }));

await test('pure TEI input validation and exact serialized-body bounds reject before metadata GET', () =>
    teiFixture(async (configuration, requests) => {
        for (const value of [
            { ...teiInput, model: '' },
            { ...teiInput, model: 'bad name' },
            { ...teiInput, query: 'é'.repeat(2001) },
            { ...teiInput, documents: [] },
            { ...teiInput, documents: ['x'.repeat(20_001)] },
            { ...teiInput, documents: Array.from({ length: 101 }, () => 'x') },
            {
                ...teiInput,
                query: 'q',
                documents: Array.from({ length: 25 }, () =>
                    '\u0000'.repeat(20_000)
                ),
            },
        ]) {
            assert.throws(() => validateRerankingInput('TEI', value));
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    value
                )
            );
        }
        assert.equal(requests.length, 0);
        const statistics = validateRerankingInput('TEI', {
            ...teiInput,
            query: 'é',
            documents: ['庭', 'x'],
        });
        assert.equal(statistics.preparedInputBytes, 8);
        assert.equal(
            statistics.serializedRequestBytes,
            Buffer.byteLength(
                JSON.stringify({
                    query: 'é',
                    texts: ['庭', 'x'],
                    truncate: false,
                    ['raw_scores']: false,
                    ['return_text']: false,
                })
            )
        );
    }));

for (const value of [undefined, '0', '137']) {
    await test('optional native compute headers remain distinct from absent billing', () =>
        teiFixture(
            async (configuration) => {
                const result = await rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    teiInput
                );
                assert.deepEqual(result.usage, {
                    providerInputTokens:
                        value === undefined ? null : Number(value),
                    billedInputTokens: null,
                    billedSearchUnits: null,
                });
            },
            (response, request) => {
                if (request.path !== '/info' && value !== undefined)
                    response.setHeader('x-compute-tokens', value);
                response.end(
                    JSON.stringify(
                        request.path === '/info' ? teiInfo() : teiResults()
                    )
                );
            }
        ));
}
for (const value of ['', '-1', '1.5', '1e3', '01', '9007199254740992']) {
    await test('malformed supplied compute counters refuse without inventing zero or unknown usage', () =>
        teiFixture(
            async (configuration) => {
                await assert.rejects(
                    rerank(
                        { ...configuration, runtimeSnapshot: teiSnapshot },
                        teiInput
                    ),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (response, request) => {
                if (request.path !== '/info')
                    response.setHeader('x-compute-tokens', value);
                response.end(
                    JSON.stringify(
                        request.path === '/info' ? teiInfo() : teiResults()
                    )
                );
            }
        ));
}

for (const invalid of [
    {},
    [{ index: 0, score: 0.5 }],
    [...teiResults(), { index: 3, score: 0.5 }],
    [
        { index: 0, score: 0.5 },
        { index: 0, score: 0.6 },
        { index: 2, score: 0.7 },
    ],
    [-1, 0.5, 3].map((index) => ({ index, score: 0.5 })),
    teiResults().map((row) => ({ ...row, score: -0.1 })),
    teiResults().map((row) => ({ ...row, score: 1.1 })),
    teiResults().map((row) => ({ ...row, score: null })),
]) {
    await test('TEI malformed score arrays cannot produce partial rankings', () =>
        teiFixture(
            async (configuration) => {
                await assert.rejects(
                    rerank(
                        { ...configuration, runtimeSnapshot: teiSnapshot },
                        teiInput
                    ),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (response, request) =>
                response.end(
                    JSON.stringify(
                        request.path === '/info' ? teiInfo() : invalid
                    )
                )
        ));
}

await test('the live info GET and native POST share one deadline, not two renewed windows', () =>
    teiFixture(
        async (configuration, requests) => {
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    teiInput,
                    { timeoutMs: 200 }
                ),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 2);
        },
        (response, request) => {
            setTimeout(
                () =>
                    response.end(
                        JSON.stringify(
                            request.path === '/info' ? teiInfo() : teiResults()
                        )
                    ),
                120
            ).unref();
        }
    ));

await test('pre-aborted operations and invalid probe inputs issue no GET or POST', () =>
    teiFixture(async (configuration, requests) => {
        const controller = new AbortController();
        controller.abort('PRIVATE_REASON');
        await assert.rejects(
            rerank(
                { ...configuration, runtimeSnapshot: teiSnapshot },
                teiInput,
                { signal: controller.signal }
            ),
            errorCode('PROVIDER_TIMEOUT')
        );
        await assert.rejects(
            probeTei(configuration, { model: '', candidatePool: 1 }),
            errorCode('MODEL_UNSUPPORTED')
        );
        await assert.rejects(
            probeTei(configuration, { model: teiModel, candidatePool: 101 }),
            errorCode('INPUT_TOO_LARGE')
        );
        assert.equal(requests.length, 0);
    }));

await test('a stalled metadata response is bounded by the same stream deadline and never reaches POST', () =>
    teiFixture(
        async (configuration, requests) => {
            await assert.rejects(
                rerank(
                    { ...configuration, runtimeSnapshot: teiSnapshot },
                    teiInput,
                    { timeoutMs: 100 }
                ),
                errorCode('PROVIDER_TIMEOUT')
            );
            assert.equal(requests.length, 1);
        },
        (response) => {
            response.writeHead(200);
            response.write('{');
        }
    ));

await test('inputs, credentials and saved metadata are captured before the first asynchronous GET', () =>
    teiFixture(async (configuration, requests) => {
        const mutable = {
            ...configuration,
            runtimeSnapshot: { ...teiSnapshot },
        };
        const payload = { ...teiInput, documents: [...teiInput.documents] };
        const pending = rerank(mutable, payload);
        mutable.endpoint = 'http://private.invalid';
        mutable.apiKey = 'PRIVATE_CHANGED_KEY';
        mutable.runtimeSnapshot.modelId = 'changed';
        payload.model = 'changed';
        payload.documents.length = 0;
        const result = await pending;
        assert.equal(result.results.length, 3);
        assert(
            requests.every(
                (request) => request.authorization === `Bearer ${key}`
            )
        );
        assert.deepEqual(requests[1]!.body.texts, teiInput.documents);
    }));
