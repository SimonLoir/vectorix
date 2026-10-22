import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f, readGrant, rpc } from './fixtures';
import { semanticLatch } from './semantic-fixtures';
import {
    assertParentPublication,
    createParentFixture,
    scanParent,
} from './parent-fixtures';

/** Real authorized parent hydration and bounded sibling deduplication, with controlled native vectors. */
export async function parentSearchTests(t: TestContext) {
    const fixture = await createParentFixture('Search and authorization', true);
    try {
        const collection = await fixture.collection(
            'Sibling-heavy parent search',
            'TOKEN_WINDOW',
            64
        );
        const text = Array.from(
            { length: 120 },
            (_, index) => `forest${String(index).padStart(3, '0')} `
        ).join('');
        const document = await fixture.upload(
            text,
            'parent-siblings.txt',
            collection.id
        );
        let generationId = '';
        let siblings = new Set<string>();
        fixture.state.beforeEmbedding = async () => {
            if (!generationId) return;
            const first = await prisma.chunk.findMany({
                where: { generationId, kind: 'CHILD' },
                orderBy: { ordinal: 'asc' },
                take: 2,
            });
            assert.equal(first.length, 2);
            assert(
                first[0]!.parentId && first[0]!.parentId === first[1]!.parentId
            );
            siblings = new Set(first.map((row) => row.text));
        };
        fixture.state.vectorForText = (input) =>
            input === 'parent-dedup-query' || siblings.has(input)
                ? [1, 0, 0]
                : [0, 1, 0];
        const started = await f.owner.rag.indexing.start({
            collectionId: collection.id,
            expectedRevision: 1,
            requestId: randomUUID(),
        });
        generationId = started.generationId;
        await scanParent(fixture, generationId, 6);
        const state = await assertParentPublication(
            generationId,
            document.id,
            text
        );
        let receipt = '';

        await t.test(
            'topK is applied after sibling deduplication and bounded parent underfill is explicit',
            async () => {
                const preview = await f.owner.rag.indexing.chunks({
                    collectionId: collection.id,
                    documentId: document.id,
                    limit: 2,
                });
                assert.equal(preview.total, state.children.length);
                assert.equal(preview.items.length, 2);
                assert.equal(
                    preview.items[0]!.parentContext?.id,
                    preview.items[1]!.parentContext?.id
                );
                assert(
                    preview.items.every(
                        (row) =>
                            row.parentContext &&
                            row.parentContext.text.length > row.text.length
                    )
                );
                const result = await f.owner.rag.indexing.search({
                    collectionId: collection.id,
                    query: 'parent-dedup-query',
                    strategy: 'VECTOR',
                    topK: 2,
                    filters: {},
                });
                assert.equal(
                    result.results.length,
                    2,
                    'The two strongest raw children share one parent; deduplicate before selecting topK.'
                );
                assert.equal(
                    new Set(result.results.map((row) => row.parentContext?.id))
                        .size,
                    2
                );
                assert.equal(
                    result.results[0]!.parentContext?.id,
                    state.children[0]!.parentId
                );
                const all = await f.owner.rag.indexing.search({
                    collectionId: collection.id,
                    query: 'parent-dedup-query',
                    strategy: 'VECTOR',
                    topK: 50,
                    filters: {},
                });
                assert.equal(all.results.length, state.parents.length);
                assert.equal(all.parentUnderfilled, true);
                for (const row of all.results) {
                    assert(
                        row.parentContext &&
                            row.startOffset !== null &&
                            row.startOffset !== undefined &&
                            row.endOffset !== null &&
                            row.endOffset !== undefined
                    );
                    assert.equal(
                        row.text,
                        text.slice(row.startOffset, row.endOffset)
                    );
                    assert.equal(
                        row.parentContext.text,
                        text.slice(
                            row.parentContext.startOffset,
                            row.parentContext.endOffset
                        )
                    );
                    assert.equal(row.sourceSpansTruncated, false);
                    assert.equal(row.parentContext.sourceSpansTruncated, false);
                    assert(row.scores.vectorRank !== null);
                }
                receipt = result.results[0]!.source.receipt;
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text,
                    text
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    text
                );
            }
        );

        await t.test(
            'parent context and child receipts enforce current grants, API-key scopes and foreign identifiers',
            async () => {
                await assert.rejects(
                    f.reader.rag.indexing.chunks({
                        collectionId: collection.id,
                    })
                );
                await assert.rejects(
                    f.other.rag.indexing.chunks({ collectionId: collection.id })
                );
                await assert.rejects(
                    f.other.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    })
                );
                await assert.rejects(
                    f.owner.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt: state.parents[0]!.id,
                    })
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                const read = await f.reader.rag.indexing.search({
                    collectionId: collection.id,
                    query: 'parent-dedup-query',
                    strategy: 'VECTOR',
                    topK: 2,
                    filters: {},
                });
                assert(read.results.every((row) => row.parentContext));
                const latch = semanticLatch();
                fixture.state.beforeEmbedding = () => latch.block();
                const inFlight = f.reader.rag.indexing
                    .search({
                        collectionId: collection.id,
                        query: 'parent-dedup-query',
                        strategy: 'VECTOR',
                        topK: 2,
                        filters: {},
                    })
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                try {
                    await latch.arrived();
                    await f.owner.rag.collections.removeGrant({
                        id: collection.id,
                        target: { type: 'member', id: f.readerMember },
                    });
                } finally {
                    delete fixture.state.beforeEmbedding;
                    latch.release();
                }
                const denied = await inFlight;
                assert(
                    denied && typeof denied === 'object' && 'code' in denied
                );
                assert(
                    ['NOT_FOUND', 'FORBIDDEN'].includes(String(denied.code))
                );
                await assert.rejects(
                    f.reader.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    })
                );

                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Parent-context read scope',
                        permissions: {
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                        },
                        collectionScopes: [
                            {
                                collectionId: collection.id,
                                read: true,
                                manageDocuments: false,
                            },
                        ],
                    });
                const api = rpc(() => ({ 'x-api-key': key.key })).admin.rag
                    .indexing;
                assert(
                    (
                        await api.search({
                            collectionId: collection.id,
                            query: 'parent-dedup-query',
                            strategy: 'VECTOR',
                            topK: 2,
                            filters: {},
                        })
                    ).results.every((row) => row.parentContext)
                );
                await prisma.apiKeyCollectionScope.delete({
                    where: {
                        ['keyId_collectionId']: {
                            keyId: key.id,
                            collectionId: collection.id,
                        },
                    },
                });
                await assert.rejects(
                    api.chunks({ collectionId: collection.id })
                );
                await assert.rejects(
                    api.sourceOriginal({ collectionId: collection.id, receipt })
                );
            }
        );
    } finally {
        await fixture.close();
    }
}
