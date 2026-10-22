import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import {
    createSemanticFixture,
    scanSemantic,
    semanticText,
} from './semantic-fixtures';

/** Actual HTTP boundary work proves bounded continuation priority under older backlog and organization capacity contention. */
export async function semanticFairnessTests(t: TestContext) {
    const fixture = await createSemanticFixture('continuation fairness');
    let collectionId = '';
    let generationId = '';
    try {
        await t.test(
            'semantic capacity holders progress before older backlog while at least five ordinary tasks keep each scan',
            async () => {
                const collection = await fixture.collection();
                collectionId = collection.id;
                await prisma.organizationQuota.update({
                    where: { organizationId: f.org },
                    data: {
                        embeddingPreparedBytesPerCandidate: 16_384n,
                        embeddingBatchesPerCandidate: 16,
                        embeddingOutstandingPreparedBytes: 6n * 16_384n,
                        embeddingOutstandingBatches: 6 * 16,
                    },
                });
                for (let index = 0; index < 21; index++)
                    await fixture.upload(
                        semanticText(64),
                        `fairness-${index}.txt`,
                        collection.id
                    );
                const started = await f.owner.rag.indexing.start({
                    collectionId,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                generationId = started.generationId;
                // Raw scans preserve accepted queue chronology; scanSemantic would move
                // every deadline and erase the older-backlog arrangement being tested.
                await fixture.scan(1);
                await fixture.scan(1);
                const initial = await prisma.indexTask.findMany({
                    where: { generationId, kind: 'INDEX_DOCUMENT' },
                });
                const plans = await prisma.semanticChunkPlan.findMany({
                    where: { generationId },
                });
                assert.equal(initial.length, 21);
                assert.equal(plans.length, 6);
                assert(
                    plans.every(
                        (plan) =>
                            plan.completedUnits === 32 && plan.unitCount === 64
                    )
                );
                const holderIds = initial
                    .filter((task) =>
                        plans.some(
                            (plan) =>
                                plan.indexedDocumentId ===
                                task.indexedDocumentId
                        )
                    )
                    .map((task) => task.id);
                const unclaimedIds = initial
                    .filter((task) => task.attempts === 0)
                    .map((task) => task.id);
                assert.equal(holderIds.length, 6);
                assert.equal(unclaimedIds.length, 11);
                assert.equal(
                    initial.filter(
                        (task) =>
                            task.stage === 'WAITING_FOR_EMBEDDING_CAPACITY'
                    ).length,
                    4
                );
                assert(
                    initial
                        .filter((task) => holderIds.includes(task.id))
                        .every(
                            (task) =>
                                task.continuationPending && task.attempts === 1
                        )
                );
                const waiting =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                assert.equal(
                    waiting.reservedPreparedBytes,
                    6n * 16_384n - waiting.dispatchedPreparedBytes
                );
                assert.equal(
                    waiting.reservedBatches,
                    96n - waiting.dispatchedBatches
                );
                // Only the documented100ms successful-continuation delay elapses.
                // Existing normal acceptedAt/availableAt ordering remains untouched.
                await new Promise((resolve) => setTimeout(resolve, 125));
                await fixture.scan(1);
                const first = await prisma.indexTask.findMany({
                    where: { generationId, kind: 'INDEX_DOCUMENT' },
                });
                assert.equal(
                    first.filter(
                        (task) =>
                            holderIds.includes(task.id) &&
                            task.status === 'COMPLETE'
                    ).length,
                    5
                );
                assert.equal(
                    first.filter(
                        (task) =>
                            unclaimedIds.includes(task.id) &&
                            task.leaseEpoch > 0n
                    ).length,
                    5
                );
                assert(first.every((task) => task.attempts <= 1));
                const oldHolder = first.find(
                    (task) =>
                        holderIds.includes(task.id) &&
                        task.status !== 'COMPLETE'
                );
                assert(oldHolder?.indexedDocumentId);
                const readyHolders = first.filter(
                    (task) =>
                        task.status === 'PENDING' &&
                        task.continuationPending &&
                        task.stage === 'SEMANTIC_PLANNING'
                );
                assert.equal(readyHolders.length, 6);
                const readyIds = readyHolders.map((task) => task.id);
                const ordinary = first.filter(
                    (task) =>
                        task.status === 'PENDING' && !readyIds.includes(task.id)
                );
                assert.equal(ordinary.length, 10);
                // A second controlled chronology catches excluding only the five picked
                // IDs: the sixth ready priority task must not consume a normal slot.
                // No lease, state, reservation, usage or completion is fabricated here.
                const readyAt = Date.now() - 1000;
                await prisma.indexTask.updateMany({
                    where: { id: { in: readyIds } },
                    data: { availableAt: new Date(readyAt + 1) },
                });
                await prisma.indexTask.update({
                    where: { id: oldHolder.id },
                    data: { availableAt: new Date(readyAt) },
                });
                await prisma.indexTask.updateMany({
                    where: { id: { in: ordinary.map((task) => task.id) } },
                    data: { availableAt: new Date(readyAt + 2) },
                });
                const previousBoundaries =
                    await prisma.embeddingWorkAttempt.findMany({
                        where: { generationId, purpose: 'BOUNDARY' },
                        select: { id: true },
                    });
                await fixture.scan(1);
                const second = await prisma.indexTask.findMany({
                    where: { generationId, kind: 'INDEX_DOCUMENT' },
                });
                assert.equal(
                    second.filter(
                        (task) =>
                            readyIds.includes(task.id) &&
                            task.status === 'COMPLETE'
                    ).length,
                    5
                );
                assert.equal(
                    second.filter((task) =>
                        ordinary.some(
                            (before) =>
                                before.id === task.id &&
                                task.leaseEpoch > before.leaseEpoch
                        )
                    ).length,
                    5
                );
                assert.equal(
                    second.find((task) => task.id === oldHolder.id)?.status,
                    'COMPLETE'
                );
                assert(second.every((task) => task.attempts <= 1));
                const nextBoundary =
                    await prisma.embeddingWorkAttempt.findFirstOrThrow({
                        where: {
                            generationId,
                            purpose: 'BOUNDARY',
                            id: {
                                notIn: previousBoundaries.map(
                                    (work) => work.id
                                ),
                            },
                        },
                        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                    });
                assert.equal(
                    nextBoundary.indexedDocumentId,
                    oldHolder.indexedDocumentId
                );
            }
        );
    } finally {
        try {
            if (collectionId && generationId) {
                await f.owner.rag.collections.delete({
                    id: collectionId,
                    expectedRevision: 1,
                });
                await scanSemantic(fixture, generationId, 8);
            }
        } finally {
            await fixture.close();
        }
    }
}
