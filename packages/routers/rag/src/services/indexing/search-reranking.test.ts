import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Prisma } from '@repo/db';
import { ORPCError } from '@orpc/server';
import { safeRerankError } from '../reranking/errors';
import {
    applyRerankScores,
    readRerankChildren,
    remainingSearchMs,
    rerankCandidateIds,
    searchProjectionIds,
    unchangedRerankChildren,
} from './search-reranking';
import { selectSearchRepresentatives } from './search-representatives';
import type { SearchChild, SearchRanking } from './search-types';

const child = (id: string, parentId: string | null = null): SearchChild => ({
    id,
    parentId,
    indexedDocumentId: 'publication',
    text: `Canonical child ${id}`,
});
const ranking = (...ids: string[]): SearchRanking =>
    ids.map((id, index) => [
        id,
        {
            rrf: 1 / (61 + index),
            lexicalRank: index + 1,
            vectorRank: null,
            vectorDistance: null,
        },
    ]);

void test('siblings remain in the bounded native pool and the strongest reranked child represents each parent', () => {
    const candidates = [
        child('a', 'parent-a'),
        child('b', 'parent-a'),
        child('c', 'parent-b'),
    ];
    const ranked = ranking('a', 'b', 'c');
    assert.deepEqual(rerankCandidateIds(ranked, candidates, 3, true), [
        'a',
        'b',
        'c',
    ]);
    const reranked = applyRerankScores(
        candidates,
        [
            { index: 2, score: 0.8 },
            { index: 1, score: 0.95 },
            { index: 0, score: 0.1 },
        ],
        ranked
    );
    assert.deepEqual(
        selectSearchRepresentatives(reranked.ranked, candidates, true, 2).map(
            ([id]) => id
        ),
        ['b', 'c']
    );
    assert.deepEqual(
        selectSearchRepresentatives(ranked, candidates, true, 2).map(
            ([id]) => id
        ),
        ['a', 'c']
    );
    assert.equal(reranked.scores.get('b'), 0.95);
    assert.equal(reranked.scores.get('c'), 0.8);
});

void test('candidate limits never expand to topK and baseline uses the same exact bounded pool', () => {
    const candidates = [child('a'), child('b'), child('c')];
    const ranked = ranking('a', 'b', 'c');
    const ids = rerankCandidateIds(ranked, candidates, 1, false);
    assert.deepEqual(ids, ['a']);
    const accepted = candidates.filter((row) => ids.includes(row.id));
    const scored = applyRerankScores(
        accepted,
        [{ index: 0, score: 0.2 }],
        ranked
    );
    assert.deepEqual(
        selectSearchRepresentatives(scored.ranked, accepted, false, 50).map(
            ([id]) => id
        ),
        ['a']
    );
    assert.deepEqual(
        ranked.filter(([id]) => scored.scores.has(id)).map(([id]) => id),
        ['a']
    );
});

void test('unknown metadata is ineligible and invalid parent layouts or pool limits fail closed', () => {
    assert.deepEqual(
        rerankCandidateIds(ranking('missing', 'a'), [child('a')], 10, false),
        ['a']
    );
    for (const limit of [0, -1, 101, 0.5, NaN, Infinity])
        assert.throws(() =>
            rerankCandidateIds(ranking('a'), [child('a')], limit, false)
        );
    assert.throws(() =>
        rerankCandidateIds(ranking('a'), [child('a')], 1, true)
    );
    assert.throws(() =>
        rerankCandidateIds(ranking('a'), [child('a', 'parent')], 1, false)
    );
});

void test('complete native permutations map by index, with deterministic score/RRF/identity ties', () => {
    const candidates = [child('z'), child('b'), child('a')];
    const ranked = ranking('z', 'b', 'a');
    ranked[1]![1].rrf = ranked[2]![1].rrf;
    const scored = applyRerankScores(
        candidates,
        [
            { index: 2, score: 0.5 },
            { index: 0, score: 0.5 },
            { index: 1, score: 0.5 },
        ],
        ranked
    );
    assert.deepEqual(
        scored.ranked.map(([id]) => id),
        ['z', 'a', 'b']
    );
    assert.deepEqual([...scored.scores.keys()], ['a', 'z', 'b']);
});

void test('missing, duplicate, invalid indices and out-of-contract native scores are refused', () => {
    const candidates = [child('a'), child('b')];
    const valid = [
        { index: 0, score: 0 },
        { index: 1, score: 1 },
    ];
    assert.equal(
        applyRerankScores(candidates, valid, ranking('a', 'b')).scores.size,
        2
    );
    const invalid = [
        [],
        [valid[0]!],
        [...valid, valid[0]!],
        [valid[0]!, valid[0]!],
        [valid[0]!, { index: 2, score: 0.5 }],
        [valid[0]!, { index: -1, score: 0.5 }],
        [valid[0]!, { index: 0.5, score: 0.5 }],
        [valid[0]!, { index: NaN, score: 0.5 }],
        ...[NaN, Infinity, -0.1, 1.1].map((score) => [
            valid[0]!,
            { index: 1, score },
        ]),
    ];
    for (const response of invalid)
        assert.throws(() =>
            applyRerankScores(candidates, response, ranking('a', 'b'))
        );
    assert.throws(() => applyRerankScores(candidates, valid, ranking('a')));
});

void test('child I/O is bounded and scoped, without selecting parent text or source arrays', async () => {
    const rows = [child('a')];
    const calls: unknown[] = [];
    const db = {
        chunk: {
            findMany: (args: unknown) => {
                calls.push(args);
                return Promise.resolve(rows);
            },
        },
    } as unknown as Prisma.TransactionClient;
    const publications: Prisma.IndexedDocumentWhereInput = {
        status: 'PUBLISHED',
        sourceVersion: { contentState: 'AVAILABLE' },
    };
    assert.equal(
        await readRerankChildren(db, {
            organizationId: 'org',
            generationId: 'g1',
            ids: ['a'],
            publications,
        }),
        rows
    );
    assert.deepEqual(calls, [
        {
            where: {
                organizationId: 'org',
                generationId: 'g1',
                kind: 'CHILD',
                id: { in: ['a'] },
                indexedDocument: publications,
            },
            select: {
                id: true,
                indexedDocumentId: true,
                parentId: true,
                text: true,
            },
            take: 1,
        },
    ]);
    assert.deepEqual(
        await readRerankChildren(db, {
            organizationId: 'org',
            generationId: 'g1',
            ids: [],
            publications,
        }),
        []
    );
    assert.equal(calls.length, 1);
    assert.throws(() =>
        readRerankChildren(db, {
            organizationId: 'org',
            generationId: 'g1',
            ids: ['a', 'a'],
            publications,
        })
    );
    assert.throws(() =>
        readRerankChildren(db, {
            organizationId: 'org',
            generationId: 'g1',
            ids: Array.from({ length: 101 }, (_, i) => String(i)),
            publications,
        })
    );
});

void test('post-I/O eligibility preserves exact child identity, publication, parent and text', () => {
    const captured = [
        child('a', 'p'),
        child('b', 'p'),
        child('c', 'q'),
        child('d', 'q'),
        child('e', 'q'),
    ];
    const current = [
        { ...captured[4]!, text: 'Changed canonical body' },
        { ...captured[2]!, indexedDocumentId: 'replacement-publication' },
        { ...captured[1]!, parentId: 'different-parent' },
        { ...captured[0]! },
    ];
    assert.deepEqual(unchangedRerankChildren(captured, current), [captured[0]]);
    assert.equal(unchangedRerankChildren(captured, current)[0], captured[0]);
    assert.deepEqual(
        unchangedRerankChildren(
            [captured[1]!, captured[0]!],
            [captured[0]!, captured[1]!]
        ),
        [captured[1], captured[0]]
    );
});

void test('reranked and comparison projections share at most 100 distinct exact child IDs', () => {
    assert.deepEqual(
        searchProjectionIds(ranking('b', 'a'), ranking('a', 'c')),
        ['b', 'a', 'c']
    );
    const hundred = ranking(
        ...Array.from({ length: 100 }, (_, i) => String(i))
    );
    assert.equal(searchProjectionIds(hundred, hundred).length, 100);
    assert.throws(() => searchProjectionIds(hundred, ranking('overflow')));
    assert.deepEqual(searchProjectionIds([], []), []);
});

void test('reranking shares the original 60 second deadline and cannot extend it', () => {
    assert.equal(remainingSearchMs(1000, 1000), 60_000);
    assert.equal(remainingSearchMs(1000, 60_000), 1000);
    assert.equal(remainingSearchMs(1000, 60_999), 1);
    for (const now of [61_000, 61_001, 999, NaN, Infinity])
        assert.throws(() => remainingSearchMs(1000, now));
});

void test('invalid search filters retain a safe explicit input refusal without private diagnostics', () => {
    const safe = safeRerankError(
        new ORPCError('BAD_REQUEST', {
            message: 'PRIVATE_FILTER_SENTINEL',
            data: { privateValue: 'PRIVATE_FILTER_SENTINEL' },
            cause: new Error('PRIVATE_FILTER_SENTINEL'),
        })
    );
    assert.equal(safe.code, 'BAD_REQUEST');
    assert.deepEqual(safe.data, { errorCode: 'RERANK_INPUT_INVALID' });
    assert.equal(safe.cause, undefined);
    assert.ok(!JSON.stringify(safe).includes('PRIVATE_FILTER_SENTINEL'));
});
