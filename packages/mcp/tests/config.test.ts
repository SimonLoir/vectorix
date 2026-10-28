import assert from 'node:assert/strict';
import test from 'node:test';
import { readConfiguration } from '../src/config';
import { listInput, searchInput, sourceInput } from '../src/schemas';

const environment = {
    VECTORIX_API_URL: 'https://vectorix.example.test',
    VECTORIX_API_KEY: 'synthetic-key',
    VECTORIX_ORGANIZATION_ID: 'organization-a',
};

await test('configuration requires a pinned organization and fails closed on empty local restrictions', () => {
    assert.equal(
        readConfiguration(environment).organizationId,
        'organization-a'
    );
    assert.equal(readConfiguration(environment).collectionIds, null);
    assert.throws(() =>
        readConfiguration({
            ...environment,
            VECTORIX_ORGANIZATION_ID: undefined,
        })
    );
    for (const value of ['', 'collection-a,', 'collection-a,,collection-b'])
        assert.throws(() =>
            readConfiguration({
                ...environment,
                VECTORIX_COLLECTION_IDS: value,
            })
        );
    assert.deepEqual(
        [
            ...(readConfiguration({
                ...environment,
                VECTORIX_COLLECTION_IDS:
                    ' collection-a,collection-b,collection-a ',
            }).collectionIds ?? []),
        ],
        ['collection-a', 'collection-b']
    );
});

await test('configuration rejects credential-bearing URLs, foreign schemes and control characters', () => {
    for (const apiUrl of [
        'file:///etc/passwd',
        'https://key@example.test',
        'https://example.test?key=value',
        'https://example.test#key',
    ])
        assert.throws(() =>
            readConfiguration({ ...environment, VECTORIX_API_URL: apiUrl })
        );
    assert.throws(() =>
        readConfiguration({
            ...environment,
            VECTORIX_API_KEY: 'key\r\nX-Organization-Id: foreign',
        })
    );
    assert.throws(() =>
        readConfiguration({
            ...environment,
            VECTORIX_COLLECTION_IDS: Array.from(
                { length: 101 },
                (_, i) => `collection-${i}`
            ).join(','),
        })
    );
});

await test('tool inputs bound work and expose neither organization selection nor original URLs', () => {
    assert.equal(listInput.parse({}).limit, 10);
    assert.equal(
        searchInput.parse({ collectionId: 'a', query: 'question' }).topK,
        5
    );
    assert.deepEqual(
        sourceInput.parse({ collectionId: 'a', receipt: 'opaque' }),
        { collectionId: 'a', receipt: 'opaque', before: 1, after: 1 }
    );
    assert.equal(listInput.safeParse({ limit: 21 }).success, false);
    assert.equal(
        searchInput.safeParse({ collectionId: 'a', query: 'q', topK: 11 })
            .success,
        false
    );
    assert.equal(
        searchInput.safeParse({
            collectionId: 'a',
            query: 'q',
            organizationId: 'foreign',
        }).success,
        false
    );
    assert.equal(
        sourceInput.safeParse({
            collectionId: 'a',
            receipt: 'opaque',
            url: 'http://foreign',
        }).success,
        false
    );
    assert.equal(
        sourceInput.safeParse({
            collectionId: 'a',
            receipt: 'opaque',
            before: 3,
        }).success,
        false
    );
});
