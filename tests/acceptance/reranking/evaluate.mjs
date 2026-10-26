/** Pure same-pool scoring against the existing byte-frozen FR/EN reference corpus. */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { safeOffset, validateFixtures } from '../quality/evaluate.mjs';
import { matchesFilters } from '../quality/queries.mjs';

const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MODELS = {
    COHERE: ['rerank-v5.0-fast', 'rerank-v5.0-pro'],
    VOYAGE: ['rerank-3', 'rerank-3-lite'],
};
export const EVALUATION_TOP_K = 10;

/** No observed ranking selects the questions: all ten frozen paraphrase questions are scored. */
export function evaluationQueries(fixtures) {
    validateFixtures(fixtures);
    const queries = fixtures.queries.filter(
        (query) => query.category === 'PARAPHRASE'
    );
    assert.equal(queries.length, 10, 'FROZEN_QUERY_COUNT');
    for (const language of ['EN', 'FR'])
        assert.equal(
            queries.filter((query) => query.language === language).length,
            5,
            'FROZEN_LANGUAGE_COUNT'
        );
    return queries;
}

/** Bind local fixture identities to one declared test generation and immutable reranking revision. */
export function validateBindings(fixtures, binding, corpusDigest, revision) {
    assert.equal(binding.schemaVersion, 1, 'BINDING_VERSION');
    assert.equal(
        binding.corpusDigest,
        fixtures.manifest.corpusDigest,
        'BINDING_CORPUS'
    );
    assert.equal(
        corpusDigest,
        fixtures.manifest.corpusDigest,
        'DECLARED_CORPUS'
    );
    assert(
        ID.test(binding.collectionId) && ID.test(binding.generationId),
        'BINDING_IDENTIFIERS'
    );
    assert(
        Number.isSafeInteger(revision) &&
            revision > 0 &&
            binding.rerankRevision === revision,
        'BINDING_PROFILE_REVISION'
    );
    assert(
        Object.hasOwn(MODELS, binding.provider) &&
            MODELS[binding.provider].includes(binding.model),
        'BINDING_REVIEWED_MODEL'
    );
    assert(
        Number.isInteger(binding.candidatePool) &&
            binding.candidatePool >= 1 &&
            binding.candidatePool <= 100,
        'BINDING_CANDIDATE_POOL'
    );
    assert(
        Array.isArray(binding.documents) &&
            binding.documents.length === fixtures.manifest.documents.length,
        'BINDING_DOCUMENT_COUNT'
    );
    const byFixture = new Map();
    const byDocument = new Map();
    for (const item of binding.documents) {
        const document = fixtures.manifest.documents.find(
            (document) => document.fixtureId === item.fixtureId
        );
        assert(
            document &&
                ID.test(item.documentId) &&
                item.version === document.version,
            'BINDING_SOURCE_VERSION'
        );
        assert(
            !byFixture.has(item.fixtureId) && !byDocument.has(item.documentId),
            'BINDING_DUPLICATE_SOURCE'
        );
        byFixture.set(item.fixtureId, item);
        byDocument.set(item.documentId, {
            ...document,
            documentId: item.documentId,
        });
    }
    return { byFixture, byDocument };
}

function validateRange(value, artifact) {
    assert(
        safeOffset(artifact.text, value.startOffset) &&
            safeOffset(artifact.text, value.endOffset) &&
            value.endOffset > value.startOffset,
        'SOURCE_CANONICAL_RANGE'
    );
    assert.equal(
        value.text,
        artifact.text.slice(value.startOffset, value.endOffset),
        'SOURCE_CANONICAL_TEXT'
    );
    const spans = artifact.sources.flatMap((source) => {
        const start = Math.max(source.start, value.startOffset),
            end = Math.min(source.end, value.endOffset);
        return start < end ? [{ source, start, end }] : [];
    });
    assert(
        isDeepStrictEqual(value.sourceSpans, spans.slice(0, 64)) &&
            value.sourceSpansTruncated === spans.length > 64,
        'SOURCE_SPAN_PROVENANCE'
    );
}

function checkedResults(fixtures, query, response, binding, adapters) {
    assert.equal(
        response.generationId,
        binding.generationId,
        'CAPTURED_GENERATION'
    );
    assert.equal(response.strategy, 'HYBRID', 'CAPTURED_STRATEGY');
    assert(
        Array.isArray(response.results) &&
            response.results.length <= EVALUATION_TOP_K,
        'BOUNDED_RESULTS'
    );
    const seen = new Set();
    return response.results.map((result) => {
        const document = adapters.byDocument.get(result.documentId);
        assert(
            document &&
                result.version === document.version &&
                result.generationId === binding.generationId &&
                result.published === true,
            'SOURCE_IDENTITY'
        );
        assert(
            ID.test(result.id) &&
                ID.test(result.publicationId) &&
                !seen.has(result.id),
            'UNIQUE_CHILD_IDENTITY'
        );
        seen.add(result.id);
        assert(matchesFilters(document, query.filters), 'SOURCE_FILTER');
        assert(
            typeof result.source?.receipt === 'string' &&
                result.source.receipt.length > 0 &&
                result.source.receipt.length <= 4096,
            'SOURCE_RECEIPT_PRESENT'
        );
        const artifact = fixtures.artifacts[document.fixtureId];
        validateRange(result, artifact);
        if (result.parentContext) validateRange(result.parentContext, artifact);
        return { result, fixtureId: document.fixtureId };
    });
}

/** Binary novelty credit: overlapping children/translations cannot repeatedly score the same judged edition. */
export function rankMetrics(gains, relevantJudgments, topK = EVALUATION_TOP_K) {
    assert(
        Array.isArray(gains) && gains.every((gain) => gain === 0 || gain === 1),
        'BINARY_GAINS'
    );
    assert(
        Number.isInteger(relevantJudgments) && relevantJudgments > 0,
        'JUDGMENT_DENOMINATOR'
    );
    assert(
        gains.reduce((sum, gain) => sum + gain, 0) <= relevantJudgments,
        'JUDGMENT_CREDIT_BOUND'
    );
    const discount = (rank) => 1 / Math.log2(rank + 2);
    const dcg = gains
        .slice(0, topK)
        .reduce((sum, gain, rank) => sum + gain * discount(rank), 0);
    const ideal = Array.from(
        { length: Math.min(topK, relevantJudgments) },
        (_, rank) => discount(rank)
    ).reduce((a, b) => a + b, 0);
    const first = gains.slice(0, topK).indexOf(1);
    return {
        ndcg: dcg / ideal,
        mrr: first < 0 ? 0 : 1 / (first + 1),
        hits: gains.slice(0, topK).reduce((a, b) => a + b, 0),
        results: gains.length,
    };
}

function scoreOrder(results, label) {
    const credited = new Set();
    const gains = results.map(({ result, fixtureId }) => {
        const edition = label.editions.find(
            (edition) =>
                edition.fixtureId === fixtureId &&
                edition.version === result.version
        );
        const relevant =
            edition &&
            edition.spans.every(
                (span) =>
                    result.startOffset <= span.startOffset &&
                    result.endOffset >= span.endOffset
            );
        if (!relevant || credited.has(fixtureId)) return 0;
        credited.add(fixtureId);
        return 1;
    });
    return rankMetrics(gains, label.editions.length);
}

/** Compare only the API's captured candidate window; never issue an independent baseline search. */
export function evaluateResponse(fixtures, query, response, binding, adapters) {
    const run = response.reranking;
    assert(
        response.comparison &&
            run &&
            run.revision === binding.rerankRevision &&
            run.provider === binding.provider &&
            run.model === binding.model &&
            run.candidateLimit === binding.candidatePool,
        'CAPTURED_RERANK_PROFILE'
    );
    assert(
        Number.isInteger(run.candidateCount) &&
            run.candidateCount >= 0 &&
            run.candidateCount <= run.candidateLimit &&
            run.rerankedCount === run.candidateCount,
        'CAPTURED_CANDIDATE_WINDOW'
    );
    assert.equal(
        response.comparison.model,
        response.model,
        'CAPTURED_EMBEDDING_MODEL'
    );
    const reranked = checkedResults(
        fixtures,
        query,
        response,
        binding,
        adapters
    );
    const baseline = checkedResults(
        fixtures,
        query,
        response.comparison,
        binding,
        adapters
    );
    for (const item of reranked) {
        assert(
            Number.isFinite(item.result.rerankScore) &&
                item.result.rerankScore >= 0 &&
                item.result.rerankScore <= 1,
            'RERANK_SCORE'
        );
        const same = baseline.find(
            (other) => other.result.id === item.result.id
        );
        if (same)
            for (const field of [
                'documentId',
                'version',
                'publicationId',
                'startOffset',
                'endOffset',
                'text',
                'sourceSpans',
                'parentContext',
            ])
                assert(
                    isDeepStrictEqual(item.result[field], same.result[field]),
                    'SAME_CHILD_PROVENANCE'
                );
    }
    const label = fixtures.qrels.find((label) => label.queryId === query.id);
    assert(label && !query.requiresJointParent, 'FROZEN_QUERY_JUDGMENT');
    return {
        queryId: query.id,
        language: query.language,
        candidateCount: run.candidateCount,
        sourceIdentityChecks: reranked.length + baseline.length,
        baseline: scoreOrder(baseline, label),
        reranked: scoreOrder(reranked, label),
    };
}

export function summarize(cells) {
    assert.equal(cells.length, 10, 'COMPLETE_QUERY_MATRIX');
    return ['ALL', 'EN', 'FR'].map((language) => {
        const selected =
            language === 'ALL'
                ? cells
                : cells.filter((cell) => cell.language === language);
        const mean = (order, metric) =>
            selected.reduce((sum, cell) => sum + cell[order][metric], 0) /
            selected.length;
        return {
            language,
            queries: selected.length,
            baseline: {
                ndcg: mean('baseline', 'ndcg'),
                mrr: mean('baseline', 'mrr'),
            },
            reranked: {
                ndcg: mean('reranked', 'ndcg'),
                mrr: mean('reranked', 'mrr'),
            },
            delta: {
                ndcg: mean('reranked', 'ndcg') - mean('baseline', 'ndcg'),
                mrr: mean('reranked', 'mrr') - mean('baseline', 'mrr'),
            },
        };
    });
}
