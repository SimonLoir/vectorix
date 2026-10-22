import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f } from './fixtures';
import { semanticLatch } from './semantic-fixtures';
import {
    assertParentPublication,
    cleanParentCollection,
    createParentFixture,
    parentProfile,
    parentText,
    scanParent,
} from './parent-fixtures';

/** Captured parent layouts retain exact sources across a real rebuild, then lose content access on detach. */
export async function parentLifecycleTests(t: TestContext) {
    const fixture = await createParentFixture('Rebuild and cleanup');
    try {
        const collection = await fixture.collection(
            'Parent-size rebuild',
            'TOKEN_WINDOW',
            64
        );
        const source = await fixture.upload(
            parentText,
            'parent-lifecycle.txt',
            collection.id
        );
        const first = await f.owner.rag.indexing.start({
            collectionId: collection.id,
            expectedRevision: 1,
            requestId: randomUUID(),
        });
        await scanParent(fixture, first.generationId, 6);
        const firstState = await assertParentPublication(
            first.generationId,
            source.id,
            parentText
        );
        const query = {
            collectionId: collection.id,
            query: 'forest',
            strategy: 'HYBRID' as const,
            topK: 5,
            filters: {},
        };
        const captured = await f.owner.rag.indexing.search(query);
        assert(captured.results[0]?.parentContext);
        const receipt = captured.results[0].source.receipt;
        let activeId = first.generationId;

        await t.test(
            'a parent-size rebuild preserves children and captured A context/source through the B switch',
            async () => {
                const saved = await f.owner.rag.collections.update({
                    id: collection.id,
                    expectedRevision: 1,
                    name: collection.name,
                    description: '',
                    profile: parentProfile('TOKEN_WINDOW', 128),
                });
                assert.equal(saved.configurationRevision, 2);
                const next = await f.owner.rag.indexing.rebuild({
                    collectionId: collection.id,
                    expectedRevision: 2,
                    expectedActiveGenerationId: first.generationId,
                    requestId: randomUUID(),
                });
                assert.equal(
                    (await f.owner.rag.indexing.search(query)).generationId,
                    first.generationId
                );
                const latch = semanticLatch();
                let captureOnce = true;
                fixture.state.beforeEmbedding = async () => {
                    if (captureOnce) {
                        captureOnce = false;
                        await latch.block();
                    }
                };
                const delayed = f.owner.rag.indexing.search(query);
                try {
                    await latch.arrived();
                    await scanParent(fixture, next.generationId, 6);
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: collection.id,
                            })
                        ).active?.id,
                        next.generationId
                    );
                } finally {
                    delete fixture.state.beforeEmbedding;
                    latch.release();
                }
                const old = await delayed;
                assert.equal(old.generationId, first.generationId);
                assert(
                    old.results.every(
                        (row) =>
                            row.parentContext &&
                            firstState.parents.some(
                                (parent) => parent.id === row.parentContext?.id
                            )
                    )
                );
                const second = await prisma.indexedDocument.findFirstOrThrow({
                    where: {
                        generationId: next.generationId,
                        documentId: source.id,
                        status: 'PUBLISHED',
                    },
                });
                const rows = await prisma.chunk.findMany({
                    where: { indexedDocumentId: second.id },
                    orderBy: { ordinal: 'asc' },
                });
                const nextChildren = rows.filter((row) => row.kind === 'CHILD');
                const nextParents = rows.filter((row) => row.kind === 'PARENT');
                assert.deepEqual(
                    nextChildren.map((row) => [
                        row.ordinal,
                        row.text,
                        row.startOffset,
                        row.endOffset,
                    ]),
                    firstState.children.map((row) => [
                        row.ordinal,
                        row.text,
                        row.startOffset,
                        row.endOffset,
                    ])
                );
                assert(nextParents.length < firstState.parents.length);
                const fresh = await f.owner.rag.indexing.search(query);
                assert.equal(fresh.generationId, next.generationId);
                assert(
                    fresh.results.every(
                        (row) =>
                            row.parentContext &&
                            nextParents.some(
                                (parent) => parent.id === row.parentContext?.id
                            )
                    )
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    parentText
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt: old.results[0]!.source.receipt,
                        })
                    ).text(),
                    parentText
                );
                assert.equal(
                    (
                        await prisma.documentSourceHold.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: firstState.candidate.id,
                            },
                        })
                    ).state,
                    'RETIRED'
                );
                activeId = next.generationId;
            }
        );

        await t.test(
            'replacement publishes only canonical v2 context and detach immediately denies old and new receipts',
            async () => {
                const version = await prisma.documentVersion.findFirstOrThrow({
                    where: { documentId: source.id, version: 1 },
                });
                const replacementText = `${parentText}\nReplacement version: les nouveaux renards visitent la forêt.`;
                await f.owner.rag.documents.replace({
                    id: source.id,
                    expectedVersionId: version.id,
                    requestId: randomUUID(),
                    file: new File([replacementText], 'parent-v2.txt'),
                    retentionDays: 0,
                });
                await processDocumentIngestions(prisma);
                await scanParent(fixture, activeId, 6);
                const result = await f.owner.rag.indexing.search(query);
                assert(result.results.length > 0);
                assert(
                    result.results.every(
                        (row) =>
                            row.version === 2 &&
                            row.parentContext &&
                            row.parentContext.text ===
                                replacementText.slice(
                                    row.parentContext.startOffset,
                                    row.parentContext.endOffset
                                )
                    )
                );
                const nextReceipt = result.results[0]!.source.receipt;
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    parentText
                );
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt: nextReceipt,
                        })
                    ).text(),
                    replacementText
                );
                await f.owner.rag.documents.setCollection({
                    id: source.id,
                    collectionId: collection.id,
                    attached: false,
                });
                assert.equal(
                    (await f.owner.rag.indexing.search(query)).results.length,
                    0
                );
                for (const stale of [receipt, nextReceipt])
                    await assert.rejects(
                        f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt: stale,
                        })
                    );
            }
        );

        await t.test(
            'real cleanup removes both kinds after vector tombstones and releases only child accounting',
            async () => {
                const generations = [first.generationId, activeId];
                await cleanParentCollection(
                    fixture,
                    collection.id,
                    generations
                );
                assert.equal(
                    await prisma.chunk.count({
                        where: { generationId: { in: generations } },
                    }),
                    0
                );
                assert.equal(
                    await prisma.documentSourceHold.count({
                        where: {
                            indexedDocument: {
                                generationId: { in: generations },
                            },
                            state: { not: 'RELEASED' },
                        },
                    }),
                    0
                );
                assert.equal(
                    await prisma.indexGeneration.count({
                        where: {
                            id: { in: generations },
                            status: { not: 'CLEANED' },
                        },
                    }),
                    0
                );
                const accounting =
                    await prisma.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                assert.equal(
                    accounting.activeChunks +
                        accounting.retainedChunks +
                        accounting.reservedChunks,
                    0n
                );
            }
        );
    } finally {
        await fixture.close();
    }
}
