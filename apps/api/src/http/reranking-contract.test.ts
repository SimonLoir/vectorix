import assert from 'node:assert/strict';
import { test } from 'node:test';
import { indexingContract } from '@repo/api-contracts/v1/rag/indexing';
import { rerankingContract } from '@repo/api-contracts/v1/rag/reranking';
import {
    searchInput,
    searchOutput,
} from '@repo/api-contracts/v1/rag/search-contract';
import { searchResult } from '@repo/api-contracts/v1/rag/indexing-types';

const ordinary = indexingContract.search['~orpc'].inputSchema;
const reranked = rerankingContract.search['~orpc'].inputSchema;
assert(ordinary && reranked);
const legacy = { collectionId: 'collection', query: '  A question  ' };
const optIn = {
    ...legacy,
    requestId: 'abcdef12-3456-4789-8abc-def012345678',
    expectedRerankRevision: 1,
};

void test('actual ordinary contract retains legacy defaults and trimmed query', () => {
    assert.equal(ordinary, searchInput);
    assert.deepEqual(ordinary.parse(legacy), {
        collectionId: 'collection',
        query: 'A question',
        topK: 10,
        strategy: 'HYBRID',
        filters: {},
    });
    assert.deepEqual(
        ordinary.parse({
            ...legacy,
            topK: 1,
            strategy: 'LEXICAL',
            filters: { tags: ['garden'] },
        }).filters,
        { tags: ['garden'] }
    );
});

void test('actual legacy contract rejects unknown outer fields, including separate opt-in siblings', () => {
    for (const extra of [
        { filter: {} },
        { rerank: true },
        { requestId: optIn.requestId },
        { expectedRerankRevision: 1 },
        { compare: true },
    ]) {
        const parsed = ordinary.safeParse({ ...legacy, ...extra });
        assert.equal(parsed.success, false);
        assert(
            !parsed.success &&
                parsed.error.issues.some(
                    (issue) => issue.code === 'unrecognized_keys'
                )
        );
    }
});

void test('actual reranked contract accepts only its explicit compatible outer siblings', () => {
    const parsed = reranked.parse(optIn);
    assert.equal(parsed.requestId, optIn.requestId);
    assert.equal(parsed.expectedRerankRevision, 1);
    assert.equal(parsed.compare, false);
    assert.equal(parsed.query, 'A question');
    assert.equal(reranked.parse({ ...optIn, compare: true }).compare, true);
    for (const extra of [{ filter: {} }, { rerank: true }, { enabled: true }]) {
        const refused = reranked.safeParse({ ...optIn, ...extra });
        assert.equal(refused.success, false);
        assert(
            !refused.success &&
                refused.error.issues.some(
                    (issue) => issue.code === 'unrecognized_keys'
                )
        );
    }
});

void test('both actual operations retain strict filters and strict metadata conditions', () => {
    const valid = {
        metadata: [{ field: 'category', operator: 'EQ', value: 'garden' }],
    };
    assert.deepEqual(
        ordinary.parse({ ...legacy, filters: valid }).filters,
        valid
    );
    assert.deepEqual(
        reranked.parse({ ...optIn, filters: valid }).filters,
        valid
    );
    for (const filters of [
        { unknownFilter: true },
        {
            metadata: [
                {
                    field: 'category',
                    operator: 'EQ',
                    value: 'garden',
                    extra: true,
                },
            ],
        },
    ]) {
        assert.equal(ordinary.safeParse({ ...legacy, filters }).success, false);
        assert.equal(reranked.safeParse({ ...optIn, filters }).success, false);
    }
});

void test('reranking keeps original nested score DTO and adds its relevance score as a sibling', () => {
    const ordinaryOutput = indexingContract.search['~orpc'].outputSchema;
    const rerankedOutput = rerankingContract.search['~orpc'].outputSchema;
    assert(ordinaryOutput && rerankedOutput);
    const rerankedResult = rerankedOutput.shape.results.element;
    assert.equal(ordinaryOutput, searchOutput);
    assert.equal(ordinaryOutput.shape.results.element, searchResult);
    assert.equal(rerankedResult.shape.scores, searchResult.shape.scores);
    assert.equal('rerankScore' in searchResult.shape, false);
    assert.equal('rerankScore' in rerankedResult.shape, true);
    const scores = {
        rrf: 0.5,
        lexicalRank: 1,
        vectorRank: null,
        vectorDistance: null,
    };
    assert.deepEqual(rerankedResult.shape.scores.parse(scores), scores);
    assert.equal(
        rerankedResult.shape.scores.safeParse({ ...scores, vectorRank: 0.5 })
            .success,
        false
    );
});
