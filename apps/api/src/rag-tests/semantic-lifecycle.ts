import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f, readGrant } from './fixtures';
import {
    createSemanticFixture,
    candidateTask,
    scanSemantic,
    semanticProfile,
    semanticSizes,
    semanticText,
} from './semantic-fixtures';

/** Actual RPC, object and vector journeys with a local synthetic native Ollama server. */
export async function semanticLifecycleTests(t: TestContext) {
    const fixture = await createSemanticFixture('lifecycle', true);
    try {
        const collection = await fixture.collection();
        const text = semanticText(200);
        const document = await fixture.upload(
            text,
            'semantic-bilingual.txt',
            collection.id
        );
        let generationId = '';
        let receipt = '';
        await t.test(
            'semantic planning continues beyond five claims without consuming failure retries and checkpoints an immutable prefix',
            async () => {
                const requestId = randomUUID();
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId,
                });
                generationId = started.generationId;
                await scanSemantic(fixture, generationId, 2);
                const task = await candidateTask(generationId, document.id);
                assert(task.indexedDocumentId);
                const prefix = await prisma.semanticChunkPlan.findUniqueOrThrow(
                    { where: { indexedDocumentId: task.indexedDocumentId } }
                );
                assert.equal(prefix.unitCount, 200);
                assert.equal(prefix.completedUnits, 32);
                assert.equal(prefix.state, 'PLANNING');
                assert.equal(task.status, 'PENDING');
                assert.equal(task.attempts, 1);
                assert.equal(task.continuations, 1);
                assert.equal(
                    await prisma.chunk.count({
                        where: { indexedDocumentId: task.indexedDocumentId },
                    }),
                    0
                );
                fixture.state.vectorForText = (value) =>
                    value.includes('Solar') ? [1, 6, 2] : [6, 1, 2];
                await scanSemantic(fixture, generationId, 12);
                const plan = await prisma.semanticChunkPlan.findUniqueOrThrow({
                    where: { indexedDocumentId: task.indexedDocumentId },
                });
                assert.equal(plan.state, 'READY');
                assert.equal(plan.completedUnits, plan.unitCount);
                assert(Array.isArray(plan.boundaryScores));
                assert(Array.isArray(prefix.boundaryScores));
                assert.deepEqual(
                    plan.boundaryScores.slice(0, prefix.boundaryScores.length),
                    prefix.boundaryScores
                );
                assert.equal(plan.lastUnitVector, null);
                assert.equal(plan.reservedBytes, 0n);
                const finished = await candidateTask(generationId, document.id);
                assert.equal(finished.status, 'COMPLETE');
                assert.equal(finished.attempts, 1);
                assert(finished.continuations >= 6);
                const status = await f.owner.rag.indexing.status({
                    collectionId: collection.id,
                });
                assert.equal(status.active?.id, generationId);
                assert.equal(
                    (
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: generationId },
                        })
                    ).chunkerVersion,
                    'semantic-utf8-v1'
                );
                const tasks = await f.owner.rag.indexing.tasks({
                    collectionId: collection.id,
                    limit: 100,
                });
                const progress = tasks.items.find(
                    (item) => item.id === task.id
                )?.semantic;
                assert(progress?.sealed);
                assert.equal(progress.completedUnits, 200);
                assert(progress.confirmedBatches > 1);
                const usage = await f.owner.rag.quota({});
                assert(usage.semantic?.usage.trackingSince);
                assert.equal(usage.semantic.usage.reservedPreparedBytes, '0');
                assert.equal(usage.semantic.usage.reservedBatches, '0');
                const work = await prisma.embeddingWorkAttempt.findMany({
                    where: { indexedDocumentId: task.indexedDocumentId },
                });
                assert(work.length >= 8);
                assert(
                    work.every(
                        (row) =>
                            row.state === 'SUCCEEDED' &&
                            row.usageRecordedAt &&
                            row.reservedBatches === 0
                    )
                );
                const accounting =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                const calls = fixture.state.embedCalls;
                assert.deepEqual(
                    await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId,
                    }),
                    started
                );
                await scanSemantic(fixture, generationId, 3);
                const after =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                assert.equal(fixture.state.embedCalls, calls);
                assert.equal(
                    after.dispatchedBatches,
                    accounting.dispatchedBatches
                );
                assert.equal(
                    after.observedSuccessfulRequests,
                    accounting.observedSuccessfulRequests
                );
                assert.equal(
                    after.observedProviderInputTokens,
                    accounting.observedProviderInputTokens
                );
            }
        );

        await t.test(
            'semantic chunk preview, three search modes and exact originals enforce current grants and foreign organization isolation',
            async () => {
                const chunks = await f.owner.rag.indexing.chunks({
                    collectionId: collection.id,
                    documentId: document.id,
                    limit: 100,
                });
                assert(chunks.total > 1);
                assert(
                    chunks.items.every(
                        (chunk) =>
                            chunk.published &&
                            chunk.version === 1 &&
                            chunk.tokenCountIsEstimate &&
                            chunk.sourceSpans.length > 0
                    )
                );
                for (const chunk of chunks.items) {
                    const start = Math.min(
                        ...chunk.sourceSpans.map((span) => span.start)
                    );
                    const end = Math.max(
                        ...chunk.sourceSpans.map((span) => span.end)
                    );
                    assert.equal(chunk.text, text.slice(start, end));
                    assert(
                        Buffer.byteLength(chunk.text) <=
                            semanticSizes.maxTokens * 3
                    );
                }
                for (const strategy of [
                    'HYBRID',
                    'VECTOR',
                    'LEXICAL',
                ] as const) {
                    const result = await f.owner.rag.indexing.search({
                        collectionId: collection.id,
                        query: 'forest',
                        strategy,
                        topK: 10,
                        filters: {},
                    });
                    assert.equal(result.generationId, generationId);
                    assert(result.results.length > 0);
                    receipt = result.results[0]!.source.receipt;
                }
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
                await assert.rejects(
                    f.reader.rag.indexing.chunks({
                        collectionId: collection.id,
                    })
                );
                await assert.rejects(
                    f.other.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    })
                );
                await assert.rejects(
                    f.other.rag.indexing.tasks({ collectionId: collection.id })
                );
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                });
                assert(
                    (
                        await f.reader.rag.indexing.search({
                            collectionId: collection.id,
                            query: 'forest',
                            strategy: 'HYBRID',
                            topK: 5,
                            filters: {},
                        })
                    ).results.length > 0
                );
                assert.equal(
                    await (
                        await f.reader.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    text
                );
                await assert.rejects(
                    f.reader.rag.indexing.rebuild({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        expectedActiveGenerationId: generationId,
                        requestId: randomUUID(),
                    })
                );
                await f.owner.rag.collections.removeGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                });
                await assert.rejects(
                    f.reader.rag.indexing.sourceOriginal({
                        collectionId: collection.id,
                        receipt,
                    })
                );
            }
        );

        await t.test(
            'a sealed semantic plan survives chunk-quota failure and retry despite changed synthetic provider vectors',
            async () => {
                const next = await fixture.collection('Sealed semantic retry');
                const source = await fixture.upload(
                    semanticText(12),
                    'semantic-retry.txt',
                    next.id
                );
                const original =
                    await prisma.organizationQuota.findUniqueOrThrow({
                        where: { organizationId: f.org },
                    });
                const started = await f.owner.rag.indexing.start({
                    collectionId: next.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await prisma.organizationQuota.update({
                    where: { organizationId: f.org },
                    data: { chunksPerCollection: 1 },
                });
                try {
                    await scanSemantic(fixture, started.generationId, 4);
                    const failed = await candidateTask(
                        started.generationId,
                        source.id
                    );
                    assert.equal(failed.status, 'FAILED');
                    assert.equal(failed.errorCode, 'QUOTA_EXCEEDED');
                    assert(failed.indexedDocumentId);
                    const sealed =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                            },
                        });
                    assert.equal(sealed.state, 'READY');
                    assert.equal(
                        await prisma.chunk.count({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                            },
                        }),
                        0
                    );
                    assert.equal(sealed.reservedPreparedBytes, 0n);
                    const boundaryCalls =
                        await prisma.embeddingWorkAttempt.count({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                                purpose: 'BOUNDARY',
                            },
                        });
                    fixture.state.vectorForText = () => [1, 1, 7];
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: {
                            chunksPerCollection: original.chunksPerCollection,
                        },
                    });
                    await f.owner.rag.indexing.retry({
                        collectionId: next.id,
                        taskId: failed.id,
                    });
                    await scanSemantic(fixture, started.generationId, 4);
                    const retried =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                            },
                        });
                    assert.deepEqual(retried.finalRanges, sealed.finalRanges);
                    assert.equal(retried.planHash, sealed.planHash);
                    assert.deepEqual(
                        retried.boundaryScores,
                        sealed.boundaryScores
                    );
                    assert.equal(
                        await prisma.embeddingWorkAttempt.count({
                            where: {
                                indexedDocumentId: failed.indexedDocumentId,
                                purpose: 'BOUNDARY',
                            },
                        }),
                        boundaryCalls
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: next.id,
                            })
                        ).active?.id,
                        started.generationId
                    );
                } finally {
                    delete fixture.state.vectorForText;
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: {
                            chunksPerCollection: original.chunksPerCollection,
                        },
                    });
                }
            }
        );

        await t.test(
            'changing the semantic percentile rebuilds a separate generation while old search and captured sources remain usable',
            async () => {
                const saved = await f.owner.rag.collections.update({
                    id: collection.id,
                    expectedRevision: 1,
                    name: collection.name,
                    description: '',
                    profile: {
                        ...semanticProfile,
                        chunking: { ...semanticSizes, semanticPercentile: 25 },
                    },
                });
                assert.equal(saved.configurationRevision, 2);
                const started = await f.owner.rag.indexing.rebuild({
                    collectionId: collection.id,
                    expectedRevision: 2,
                    expectedActiveGenerationId: generationId,
                    requestId: randomUUID(),
                });
                const stillOld = await f.owner.rag.indexing.search({
                    collectionId: collection.id,
                    query: 'forest',
                    strategy: 'HYBRID',
                    topK: 5,
                    filters: {},
                });
                assert.equal(stillOld.generationId, generationId);
                await scanSemantic(fixture, started.generationId, 12);
                const status = await f.owner.rag.indexing.status({
                    collectionId: collection.id,
                });
                assert.equal(status.active?.id, started.generationId);
                const before = await prisma.indexGeneration.findUniqueOrThrow({
                    where: { id: generationId },
                });
                assert.equal(before.status, 'RETIRED');
                assert(before.cleanupAfter && before.cleanupAfter > new Date());
                const after = await f.owner.rag.indexing.search({
                    collectionId: collection.id,
                    query: 'forest',
                    strategy: 'HYBRID',
                    topK: 5,
                    filters: {},
                });
                assert.equal(after.generationId, started.generationId);
                assert.equal(
                    await (
                        await f.owner.rag.indexing.sourceOriginal({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text(),
                    text
                );
                assert.equal(
                    (
                        await f.owner.rag.indexing.sourcePreview({
                            collectionId: collection.id,
                            receipt,
                        })
                    ).text,
                    text
                );
            }
        );
    } finally {
        await fixture.close();
    }
}
