import assert from 'node:assert/strict';
import test from 'node:test';
import { exactCitation, exactContext, retrievedSearch } from '../src/outputs';
import { citation, context, fixtureReceipt, search } from './fixture';

await test('MCP output projection drops unrecognized fields and requires typed receipt dates', () => {
    const original = search();
    assert.deepEqual(
        retrievedSearch({ ...original, privateCredential: 'never-return' }, 5),
        original
    );
    assert.throws(
        () =>
            exactCitation({
                ...citation(),
                source: { receipt: fixtureReceipt, expiresAt: '2030-01-01' },
            }),
        { code: 'INVALID_API_RESPONSE' }
    );
});

await test('search refuses generation drift and more results than the explicit selected count', () => {
    const original = search();
    assert.throws(
        () =>
            retrievedSearch(
                {
                    ...original,
                    results: [
                        {
                            ...original.results[0],
                            generationId: 'generation-b',
                        },
                    ],
                },
                5
            ),
        { code: 'INVALID_API_RESPONSE' }
    );
    assert.throws(
        () =>
            retrievedSearch(
                {
                    ...original,
                    results: [...original.results, ...original.results],
                },
                1
            ),
        { code: 'INVALID_API_RESPONSE' }
    );
});

await test('source expansion refuses cross-publication children, expiry refresh and requested-window overflow', () => {
    const anchor = exactCitation(citation());
    const original = context();
    const neighbor = {
        ...original.passages[0],
        chunkId: 'child-b',
        ordinal: 2,
        relation: 'AFTER',
        source: { ...citation().source, receipt: 'neighbor-receipt' },
    };
    const input = { receipt: fixtureReceipt, before: 1, after: 1 };
    assert.throws(
        () =>
            exactContext(
                {
                    ...original,
                    passages: [
                        ...original.passages,
                        { ...neighbor, publicationId: 'foreign' },
                    ],
                },
                anchor,
                input
            ),
        { code: 'INVALID_API_RESPONSE' }
    );
    assert.throws(
        () =>
            exactContext(
                {
                    ...original,
                    passages: [
                        ...original.passages,
                        {
                            ...neighbor,
                            source: {
                                ...neighbor.source,
                                expiresAt: new Date('2030-01-02'),
                            },
                        },
                    ],
                },
                anchor,
                input
            ),
        { code: 'INVALID_API_RESPONSE' }
    );
    assert.throws(
        () =>
            exactContext(
                { ...original, passages: [...original.passages, neighbor] },
                anchor,
                { ...input, before: 0, after: 0 }
            ),
        { code: 'INVALID_API_RESPONSE' }
    );
});
