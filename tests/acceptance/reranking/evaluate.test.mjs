import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFixtures } from '../quality/fixture-loader.mjs';
import {
    evaluateResponse,
    evaluationQueries,
    rankMetrics,
    summarize,
    validateBindings,
} from './evaluate.mjs';
import { curlJson, evaluationEnvironment, runEvaluation } from './run.mjs';

const fixtures = await loadFixtures();
const queries = evaluationQueries(fixtures);
const binding = {
    schemaVersion: 1,
    corpusDigest: fixtures.manifest.corpusDigest,
    collectionId: 'test-collection',
    generationId: 'test-generation',
    rerankRevision: 1,
    provider: 'COHERE',
    model: 'rerank-v5.0-fast',
    candidatePool: 50,
    documents: fixtures.manifest.documents.map((document, index) => ({
        fixtureId: document.fixtureId,
        documentId: `doc-${index}`,
        version: document.version,
    })),
};
const adapters = validateBindings(fixtures, binding, binding.corpusDigest, 1);
const environment = {
    VECTORIX_RERANK_EVAL_RUN: '1',
    VECTORIX_RERANK_EVAL_TEST_SCOPE: '1',
    VECTORIX_RERANK_EVAL_ENDPOINT:
        'http://127.0.0.1:4000/api/v1/admin/rag/collections/test-collection/reranked-search',
    VECTORIX_RERANK_EVAL_API_KEY: 'synthetic-test-key',
    VECTORIX_RERANK_EVAL_CORPUS_SHA256: binding.corpusDigest,
    VECTORIX_RERANK_EVAL_PROFILE_REVISION: '1',
};
function result(fixtureId) {
    const document = adapters.byFixture.get(fixtureId);
    const artifact = fixtures.artifacts[fixtureId];
    return {
        id: `child-${document.documentId}`,
        generationId: binding.generationId,
        publicationId: `publication-${document.documentId}`,
        documentId: document.documentId,
        version: document.version,
        published: true,
        text: artifact.text,
        startOffset: 0,
        endOffset: artifact.text.length,
        sourceSpans: artifact.sources.map((source) => ({
            source,
            start: source.start,
            end: source.end,
        })),
        sourceSpansTruncated: false,
        source: { receipt: 'private-receipt-must-not-persist' },
        rerankScore: 0.8,
    };
}
function response() {
    const relevant = result('m7c-f02-en-v1'),
        decoy = result('m7c-f01-en-v1');
    return {
        generationId: binding.generationId,
        model: 'embeddinggemma:latest',
        strategy: 'HYBRID',
        results: [relevant, decoy],
        comparison: {
            generationId: binding.generationId,
            model: 'embeddinggemma:latest',
            strategy: 'HYBRID',
            results: [decoy, relevant],
        },
        reranking: {
            revision: 1,
            provider: binding.provider,
            model: binding.model,
            candidateLimit: 50,
            candidateCount: 2,
            rerankedCount: 2,
        },
    };
}

test('frozen FR/EN paraphrase matrix and declared corpus/profile bindings', () => {
    assert.equal(queries.length, 10);
    assert.throws(
        () => validateBindings(fixtures, binding, '0'.repeat(64), 1),
        /DECLARED_CORPUS/u
    );
    assert.throws(
        () => validateBindings(fixtures, binding, binding.corpusDigest, 2),
        /BINDING_PROFILE_REVISION/u
    );
    const foreign = structuredClone(binding);
    foreign.documents[1].documentId = foreign.documents[0].documentId;
    assert.throws(
        () => validateBindings(fixtures, foreign, binding.corpusDigest, 1),
        /BINDING_DUPLICATE_SOURCE/u
    );
});

test('binary nDCG and MRR retain observed rank and bound relevance credit', () => {
    assert.equal(rankMetrics([1, 0], 1).ndcg, 1);
    assert.equal(rankMetrics([0, 1], 1).mrr, 0.5);
    assert.equal(rankMetrics([0, 1], 1).ndcg, 1 / Math.log2(3));
    assert.equal(rankMetrics([], 1).mrr, 0);
    assert.throws(() => rankMetrics([1, 1], 1), /JUDGMENT_CREDIT_BOUND/u);
});

test('same-pool orders score exact canonical child identities without retaining content or receipts', () => {
    const cell = evaluateResponse(
        fixtures,
        queries.find((query) => query.id === 'Q06-EN'),
        response(),
        binding,
        adapters
    );
    assert.equal(cell.baseline.mrr, 0.5);
    assert.equal(cell.reranked.mrr, 1);
    assert.equal(cell.sourceIdentityChecks, 4);
    assert(
        !JSON.stringify(cell).includes('private-receipt') &&
            !JSON.stringify(cell).includes('ORION')
    );
    assert.throws(() => summarize([cell]), /COMPLETE_QUERY_MATRIX/u);
});

for (const [name, change, expected] of [
    [
        'foreign source',
        (value) => {
            value.results[0].documentId = 'foreign';
        },
        /SOURCE_IDENTITY/u,
    ],
    [
        'wrong version',
        (value) => {
            value.results[0].version = 2;
        },
        /SOURCE_IDENTITY/u,
    ],
    [
        'wrong generation',
        (value) => {
            value.generationId = 'other';
        },
        /CAPTURED_GENERATION/u,
    ],
    [
        'altered canonical text',
        (value) => {
            value.results[0].text = 'altered';
        },
        /SOURCE_CANONICAL_TEXT/u,
    ],
    [
        'stale rerank revision',
        (value) => {
            value.reranking.revision = 2;
        },
        /CAPTURED_RERANK_PROFILE/u,
    ],
    [
        'missing same-pool comparison',
        (value) => {
            delete value.comparison;
        },
        /CAPTURED_RERANK_PROFILE/u,
    ],
])
    test(`reject ${name}`, () => {
        const value = structuredClone(response());
        change(value);
        assert.throws(
            () =>
                evaluateResponse(
                    fixtures,
                    queries.find((query) => query.id === 'Q06-EN'),
                    value,
                    binding,
                    adapters
                ),
            expected
        );
    });

test('explicit opt-in and test scope fail before any injected transport call', async () => {
    assert.throws(() => evaluationEnvironment({}), /EXPLICIT_RUN_REQUIRED/u);
    assert.throws(
        () =>
            evaluationEnvironment({
                ...environment,
                VECTORIX_RERANK_EVAL_TEST_SCOPE: '0',
            }),
        /EXPLICIT_TEST_SCOPE_REQUIRED/u
    );
    let calls = 0;
    await assert.rejects(
        runEvaluation({
            environment: {},
            bindingPath: 'unused',
            reportPath: 'unused-report',
            transport: () => {
                calls++;
            },
        }),
        /EXPLICIT_RUN_REQUIRED/u
    );
    assert.equal(calls, 0);
});

test('curl keeps key/query off argv and excludes inherited configuration without making HTTP calls', () => {
    let invocation;
    const value = curlJson(
        new URL(environment.VECTORIX_RERANK_EVAL_ENDPOINT),
        environment.VECTORIX_RERANK_EVAL_API_KEY,
        { query: 'Été "français"\nnext' },
        (...args) => {
            invocation = args;
            return { status: 0, stdout: '{"ok":true}\n200' };
        }
    );
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(invocation[1], ['-q', '--config', '-']);
    assert(invocation[2].input.includes('synthetic-test-key'));
    assert.equal(invocation[2].env.HTTPS_PROXY, undefined);
    assert(!JSON.stringify(invocation[1]).includes('synthetic-test-key'));
});

test('injected empty-result matrix writes a private text-free report and refuses an existing report before calls', async () => {
    const directory = await mkdtemp(
        join(tmpdir(), 'vectorix-rerank-evaluator-')
    );
    try {
        const bindingPath = join(directory, 'binding.json'),
            reportPath = join(directory, 'report.json');
        await writeFile(bindingPath, JSON.stringify(binding), { mode: 0o600 });
        const calls = [];
        const transport = (url, key, body) => {
            calls.push({ path: url.pathname, body });
            if (url.pathname.endsWith('/reranking'))
                return {
                    revision: 1,
                    enabled: true,
                    canUse: true,
                    configuration: {
                        provider: binding.provider,
                        model: binding.model,
                        candidatePool: 50,
                    },
                };
            if (url.pathname.endsWith('/index-status'))
                return {
                    canRead: true,
                    active: { id: binding.generationId, status: 'ACTIVE' },
                };
            return {
                generationId: binding.generationId,
                model: 'embeddinggemma:latest',
                strategy: 'HYBRID',
                results: [],
                comparison: {
                    generationId: binding.generationId,
                    model: 'embeddinggemma:latest',
                    strategy: 'HYBRID',
                    results: [],
                },
                reranking: {
                    revision: 1,
                    provider: binding.provider,
                    model: binding.model,
                    candidateLimit: 50,
                    candidateCount: 0,
                    rerankedCount: 0,
                },
            };
        };
        const report = await runEvaluation({
            environment,
            bindingPath,
            reportPath,
            transport,
        });
        assert.equal(calls.length, 12);
        assert.equal(calls.filter((call) => call.body).length, 10);
        assert(
            calls
                .filter((call) => call.body)
                .every((call) => call.body.compare === true)
        );
        assert.equal(
            new Set(
                calls
                    .filter((call) => call.body)
                    .map((call) => call.body.requestId)
            ).size,
            10
        );
        assert.equal(report.hostedProviderAcceptance, 'NOT_ATTESTED');
        const bytes = await readFile(reportPath, 'utf8');
        assert(
            !bytes.includes('synthetic-test-key') &&
                !bytes.includes(queries[0].text)
        );
        await assert.rejects(
            runEvaluation({ environment, bindingPath, reportPath, transport }),
            /REPORT_ALREADY_EXISTS/u
        );
        assert.equal(calls.length, 12);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
