import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    rerank,
    validateRerankingInput,
    RERANKING_LIMITS,
    type RerankingInput,
} from '../src/index';
import {
    RERANKING_MODELS,
    listRerankingModels,
    type RerankingModel,
    type HostedRerankingProvider,
} from '../src/models';
import { errorCode, fixture, input, key, success } from './fixture';

await test('reviewed browser-safe catalog is frozen and provider-specific', () => {
    assert(Object.isFrozen(RERANKING_MODELS));
    assert(
        RERANKING_MODELS.every(
            (model) =>
                Object.isFrozen(model) &&
                model.contextTokens ===
                    (model.provider === 'TEI' ? 8192 : 32_000)
        )
    );
    assert.deepEqual(
        listRerankingModels('COHERE').map((model) => model.id),
        ['rerank-v5.0-fast', 'rerank-v5.0-pro']
    );
    assert.deepEqual(
        listRerankingModels('VOYAGE').map((model) => model.id),
        ['rerank-3', 'rerank-3-lite']
    );
});

for (const model of RERANKING_MODELS.filter(
    (entry): entry is RerankingModel & { provider: HostedRerankingProvider } =>
        entry.provider !== 'TEI'
)) {
    await test(`${model.provider} ${model.id} sends one exact native DTO and returns a complete stable ranking`, () =>
        fixture(model.provider, async (configuration, requests) => {
            const result = await rerank(configuration, {
                ...input,
                model: model.id,
            });
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
            assert(
                Number.isFinite(result.durationMs) &&
                    result.durationMs >= 0 &&
                    result.durationMs < 15_000
            );
            assert.equal(requests.length, 1);
            assert.deepEqual(requests[0], {
                method: 'POST',
                path: model.provider === 'COHERE' ? '/v2/rerank' : '/v1/rerank',
                authorization: `Bearer ${key}`,
                contentType: 'application/json',
                bytes: requests[0]!.bytes,
                body:
                    model.provider === 'COHERE'
                        ? {
                              model: model.id,
                              query: input.query,
                              documents: input.documents,
                              ['top_n']: 3,
                              ['max_tokens_per_doc']: 24_000,
                          }
                        : {
                              model: model.id,
                              query: input.query,
                              documents: input.documents,
                              ['top_k']: 3,
                              ['return_documents']: false,
                              truncation: false,
                          },
            });
        }));
}

await test('Cohere native token observations and billed units remain distinct, including explicit zero', () =>
    fixture(
        'COHERE',
        async (configuration) => {
            const result = await rerank(configuration, input);
            assert.deepEqual(result.usage, {
                providerInputTokens: 73,
                billedInputTokens: 0,
                billedSearchUnits: 1.5,
            });
        },
        (response) =>
            response.end(
                JSON.stringify({
                    ...success('COHERE', input.model),
                    meta: {
                        tokens: { ['input_tokens']: 73 },
                        ['billed_units']: {
                            ['input_tokens']: 0,
                            ['search_units']: 1.5,
                        },
                    },
                })
            )
    ));

await test('Voyage reads native usage.total_tokens without inventing billed usage', () =>
    fixture(
        'VOYAGE',
        async (configuration) => {
            const result = await rerank(configuration, {
                ...input,
                model: 'rerank-3',
            });
            assert.deepEqual(result.usage, {
                providerInputTokens: 0,
                billedInputTokens: null,
                billedSearchUnits: null,
            });
        },
        (response) =>
            response.end(
                JSON.stringify({
                    ...success('VOYAGE', 'rerank-3'),
                    usage: { ['total_tokens']: 0 },
                })
            )
    ));

await test('input statistics use UTF-8 bytes and exact serialized native body before admission', () => {
    const candidate = { ...input, query: 'é', documents: ['庭', 'x'] };
    const statistics = validateRerankingInput('COHERE', candidate);
    assert.equal(statistics.candidateCount, 2);
    assert.equal(statistics.preparedInputBytes, 8);
    assert.equal(
        statistics.serializedRequestBytes,
        Buffer.byteLength(
            JSON.stringify({
                ...candidate,
                ['top_n']: 2,
                ['max_tokens_per_doc']: 24_000,
            })
        )
    );
});

await test('exact UTF-8 per-query, per-document and 100-candidate limits are admitted without changing text', () =>
    fixture('COHERE', async (configuration, requests) => {
        const boundary = {
            ...input,
            query: 'é'.repeat(2000),
            documents: ['庭'.repeat(6666) + 'ab'],
        };
        await rerank(configuration, boundary);
        assert.equal(requests[0]!.body.query as string, boundary.query);
        assert.deepEqual(requests[0]!.body.documents, boundary.documents);
        await rerank(configuration, {
            ...input,
            documents: Array.from({ length: 100 }, () => ''),
        });
        assert.equal((requests[1]!.body.documents as string[]).length, 100);
    }));

await test('repeated query budget admits exactly 512_000 bytes and rejects the next byte before dispatch', () =>
    fixture('VOYAGE', async (configuration, requests) => {
        const boundary = {
            model: 'rerank-3',
            query: 'q'.repeat(4000),
            documents: Array.from({ length: 100 }, () => 'd'.repeat(1120)),
        };
        assert.equal(
            validateRerankingInput('VOYAGE', boundary).preparedInputBytes,
            512_000
        );
        await rerank(configuration, boundary);
        const beyond = { ...boundary, documents: [...boundary.documents] };
        beyond.documents[0] += 'x';
        await assert.rejects(
            rerank(configuration, beyond),
            errorCode('INPUT_TOO_LARGE')
        );
        assert.equal(requests.length, 1);
    }));

const invalidInputs: {
    label: string;
    candidate: RerankingInput;
    code: string;
}[] = [
    {
        label: 'unknown model',
        candidate: { ...input, model: 'unreviewed' },
        code: 'MODEL_UNSUPPORTED',
    },
    {
        label: 'another provider model',
        candidate: { ...input, model: 'rerank-3' },
        code: 'MODEL_UNSUPPORTED',
    },
    {
        label: 'empty query',
        candidate: { ...input, query: '' },
        code: 'INPUT_TOO_LARGE',
    },
    {
        label: 'empty candidate list',
        candidate: { ...input, documents: [] },
        code: 'INPUT_TOO_LARGE',
    },
    {
        label: '101 candidates',
        candidate: {
            ...input,
            documents: Array.from({ length: 101 }, () => 'x'),
        },
        code: 'INPUT_TOO_LARGE',
    },
    {
        label: 'UTF-8 query overflow',
        candidate: { ...input, query: 'é'.repeat(2000) + 'x' },
        code: 'INPUT_TOO_LARGE',
    },
    {
        label: 'UTF-8 document overflow',
        candidate: { ...input, documents: ['庭'.repeat(6666) + 'abc'] },
        code: 'INPUT_TOO_LARGE',
    },
    {
        label: 'non-string document',
        candidate: { ...input, documents: [2] as unknown as string[] },
        code: 'INPUT_TOO_LARGE',
    },
    {
        label: 'escape-expanded serialized body',
        candidate: {
            ...input,
            query: 'q',
            documents: Array.from({ length: 25 }, () =>
                '\u0000'.repeat(20_000)
            ),
        },
        code: 'INPUT_TOO_LARGE',
    },
];
for (const { label, candidate, code } of invalidInputs) {
    await test(`${label} refuses before HTTP and before a caller can admit cost`, () =>
        fixture('COHERE', async (configuration, requests) => {
            assert.throws(
                () => validateRerankingInput('COHERE', candidate),
                errorCode(code)
            );
            await assert.rejects(
                rerank(configuration, candidate),
                errorCode(code)
            );
            assert.equal(requests.length, 0);
        }));
}

const malformedResults = [
    { label: 'missing index', rows: [{ index: 0, ['relevance_score']: 0.5 }] },
    {
        label: 'duplicate index',
        rows: [0, 1, 1].map((index) => ({ index, ['relevance_score']: 0.5 })),
    },
    {
        label: 'out-of-range index',
        rows: [0, 1, 3].map((index) => ({ index, ['relevance_score']: 0.5 })),
    },
    {
        label: 'negative index',
        rows: [-1, 1, 2].map((index) => ({ index, ['relevance_score']: 0.5 })),
    },
    {
        label: 'fractional index',
        rows: [0, 1, 1.5].map((index) => ({ index, ['relevance_score']: 0.5 })),
    },
    {
        label: 'negative score',
        rows: [0, 1, 2].map((index) => ({ index, ['relevance_score']: -0.1 })),
    },
    {
        label: 'score above one',
        rows: [0, 1, 2].map((index) => ({ index, ['relevance_score']: 1.01 })),
    },
    {
        label: 'null score',
        rows: [0, 1, 2].map((index) => ({ index, ['relevance_score']: null })),
    },
];
for (const provider of ['COHERE', 'VOYAGE'] as const) {
    for (const { label, rows } of malformedResults) {
        await test(`${provider} ${label} never yields a partial ranking`, () =>
            fixture(
                provider,
                async (configuration, requests) => {
                    await assert.rejects(
                        rerank(configuration, {
                            ...input,
                            model:
                                provider === 'COHERE'
                                    ? input.model
                                    : 'rerank-3',
                        }),
                        errorCode('INVALID_PROVIDER_RESPONSE')
                    );
                    assert.equal(requests.length, 1);
                },
                (response) =>
                    response.end(
                        JSON.stringify(
                            provider === 'COHERE'
                                ? { results: rows }
                                : {
                                      object: 'list',
                                      model: 'rerank-3',
                                      data: rows,
                                  }
                        )
                    )
            ));
    }
}

await test('a nonfinite native score and wrong returned model are rejected', async () => {
    await fixture(
        'COHERE',
        async (configuration) => {
            await assert.rejects(
                rerank(configuration, input),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (response) =>
            response.end(
                '{"results":[{"index":0,"relevance_score":1e999},{"index":1,"relevance_score":0},{"index":2,"relevance_score":0}]}'
            )
    );
    await fixture(
        'VOYAGE',
        async (configuration) => {
            await assert.rejects(
                rerank(configuration, { ...input, model: 'rerank-3' }),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (response) =>
            response.end(JSON.stringify(success('VOYAGE', 'different-model')))
    );
});

for (const invalidUsage of [-1, 1e100, '4', 1.5]) {
    await test(`invalid Voyage token observation ${String(invalidUsage)} refuses`, () =>
        fixture(
            'VOYAGE',
            async (configuration) => {
                await assert.rejects(
                    rerank(configuration, { ...input, model: 'rerank-3' }),
                    errorCode('INVALID_PROVIDER_RESPONSE')
                );
            },
            (response) =>
                response.end(
                    JSON.stringify({
                        ...success('VOYAGE', 'rerank-3'),
                        usage: { ['total_tokens']: invalidUsage },
                    })
                )
        ));
}

await test('malformed billed observations refuse rather than becoming zero or unknown', () =>
    fixture(
        'COHERE',
        async (configuration) => {
            await assert.rejects(
                rerank(configuration, input),
                errorCode('INVALID_PROVIDER_RESPONSE')
            );
        },
        (response) =>
            response.end(
                JSON.stringify({
                    ...success('COHERE', input.model),
                    meta: { ['billed_units']: { ['search_units']: -1 } },
                })
            )
    ));

await test('a request snapshots its model and candidate list across asynchronous HTTP', () =>
    fixture('VOYAGE', async (configuration) => {
        const mutable = {
            ...input,
            model: 'rerank-3',
            documents: [...input.documents],
        };
        const pending = rerank(configuration, mutable);
        mutable.model = 'different-model';
        mutable.documents.length = 0;
        const result = await pending;
        assert.equal(result.results.length, 3);
    }));

await test('documented limit constants remain explicit', () => {
    assert.deepEqual(RERANKING_LIMITS, {
        documents: 100,
        queryBytes: 4000,
        documentBytes: 20_000,
        repeatedInputBytes: 512_000,
        requestBytes: 2_097_152,
        responseBytes: 262_144,
        timeoutMs: 15_000,
    });
});
