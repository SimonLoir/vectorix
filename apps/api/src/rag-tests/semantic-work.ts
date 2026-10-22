import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import {
    createSemanticFixture,
    candidateTask,
    scanSemantic,
    semanticLatch,
    semanticText,
} from './semantic-fixtures';

/** Work reservations and late native evidence use actual database transitions, never fabricated settlement counters. */
export async function semanticWorkTests(t: TestContext) {
    const fixture = await createSemanticFixture('work', true);
    try {
        const original = await prisma.organizationQuota.findUniqueOrThrow({
            where: { organizationId: f.org },
        });
        const limits = {
            semanticUnitsPerDocument: original.semanticUnitsPerDocument,
            semanticPlanBytesPerDocument: original.semanticPlanBytesPerDocument,
            semanticPlanBytesPerOrganization:
                original.semanticPlanBytesPerOrganization,
            embeddingPreparedBytesPerCandidate:
                original.embeddingPreparedBytesPerCandidate,
            embeddingBatchesPerCandidate: original.embeddingBatchesPerCandidate,
            embeddingOutstandingPreparedBytes:
                original.embeddingOutstandingPreparedBytes,
            embeddingOutstandingBatches: original.embeddingOutstandingBatches,
        };
        try {
            await t.test(
                'candidate prepared-work limit rejects before native dispatch or partial chunk materialization',
                async () => {
                    const collection = await fixture.collection(
                        'Semantic prepared-byte cap'
                    );
                    const document = await fixture.upload(
                        semanticText(32),
                        'semantic-cap.txt',
                        collection.id
                    );
                    const started = await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: { embeddingPreparedBytesPerCandidate: 1024n },
                    });
                    try {
                        const calls = fixture.state.embedCalls;
                        await scanSemantic(fixture, started.generationId, 4);
                        const task = await candidateTask(
                            started.generationId,
                            document.id
                        );
                        assert.equal(task.status, 'FAILED');
                        assert.equal(task.errorCode, 'QUOTA_EXCEEDED');
                        assert.equal(fixture.state.embedCalls, calls);
                        assert(task.indexedDocumentId);
                        assert.equal(
                            await prisma.chunk.count({
                                where: {
                                    indexedDocumentId: task.indexedDocumentId,
                                },
                            }),
                            0
                        );
                        assert.equal(
                            await prisma.embeddingWorkAttempt.count({
                                where: {
                                    indexedDocumentId: task.indexedDocumentId,
                                },
                            }),
                            0
                        );
                        const plan =
                            await prisma.semanticChunkPlan.findUniqueOrThrow({
                                where: {
                                    indexedDocumentId: task.indexedDocumentId,
                                },
                            });
                        assert.equal(plan.completedUnits, 0);
                        assert.equal(plan.reservedBytes, 0n);
                        assert(plan.storedBytes > 0n);
                        assert.equal(plan.reservedPreparedBytes, 0n);
                        assert.equal(plan.reservedBatches, 0);
                    } finally {
                        await prisma.organizationQuota.update({
                            where: { organizationId: f.org },
                            data: limits,
                        });
                    }
                }
            );

            await t.test(
                'organization work contention defers without spending failure retries and resumes after the real first task releases capacity',
                async () => {
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: {
                            embeddingPreparedBytesPerCandidate: 16_384n,
                            embeddingOutstandingPreparedBytes: 16_384n,
                            embeddingBatchesPerCandidate: 16,
                            embeddingOutstandingBatches: 16,
                        },
                    });
                    const first = await fixture.collection('Capacity holder');
                    const second = await fixture.collection('Capacity waiter');
                    await fixture.upload(
                        semanticText(12),
                        'holder.txt',
                        first.id
                    );
                    await fixture.upload(
                        semanticText(12),
                        'waiter.txt',
                        second.id
                    );
                    const a = await f.owner.rag.indexing.start({
                        collectionId: first.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    const b = await f.owner.rag.indexing.start({
                        collectionId: second.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await fixture.scan(1); // Both provisioning tasks; INDEX_DOCUMENT was not eligible in the captured scan.
                    const taskA = await candidateTask(a.generationId);
                    const taskB = await candidateTask(b.generationId);
                    await prisma.indexTask.update({
                        where: { id: taskB.id },
                        data: { availableAt: new Date(Date.now() + 60_000) },
                    });
                    const latch = semanticLatch();
                    fixture.state.beforeEmbedding = async () => {
                        delete fixture.state.beforeEmbedding;
                        await latch.block();
                    };
                    const running = scanSemantic(fixture, a.generationId, 1);
                    try {
                        await latch.arrived();
                        const calls = fixture.state.embedCalls;
                        for (let pass = 0; pass < 6; pass++)
                            await scanSemantic(fixture, b.generationId, 1);
                        const waiting = await candidateTask(b.generationId);
                        assert.equal(waiting.status, 'PENDING');
                        assert.equal(
                            waiting.stage,
                            'WAITING_FOR_EMBEDDING_CAPACITY'
                        );
                        assert.equal(waiting.attempts, 1);
                        assert(waiting.continuations >= 6);
                        assert.equal(fixture.state.embedCalls, calls);
                        assert.equal(
                            await prisma.semanticChunkPlan.count({
                                where: {
                                    indexedDocumentId:
                                        waiting.indexedDocumentId!,
                                },
                            }),
                            0
                        );
                        const capacity =
                            await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                                { where: { organizationId: f.org } }
                            );
                        assert.equal(capacity.reservedPreparedBytes, 16_384n);
                        assert.equal(capacity.reservedBatches, 16n);
                    } finally {
                        latch.release();
                        delete fixture.state.beforeEmbedding;
                        await running;
                    }
                    await scanSemantic(fixture, a.generationId, 2);
                    await scanSemantic(fixture, b.generationId, 4);
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: first.id,
                            })
                        ).active?.id,
                        a.generationId
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: second.id,
                            })
                        ).active?.id,
                        b.generationId
                    );
                    assert.equal(
                        (await candidateTask(b.generationId)).attempts,
                        1
                    );
                    const capacity =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    assert.equal(capacity.reservedPreparedBytes, 0n);
                    assert.equal(capacity.reservedBatches, 0n);
                    assert(taskA.indexedDocumentId);
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: limits,
                    });
                }
            );

            await t.test(
                'retry cannot reset lifetime dispatched batches and discard removes planning content through real cleanup',
                async () => {
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: { embeddingBatchesPerCandidate: 1 },
                    });
                    const collection = await fixture.collection(
                        'Lifetime dispatch cap'
                    );
                    await fixture.upload(
                        semanticText(64),
                        'lifetime.txt',
                        collection.id
                    );
                    const started = await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await scanSemantic(fixture, started.generationId, 4);
                    const task = await candidateTask(started.generationId);
                    assert(task.indexedDocumentId);
                    assert.equal(task.status, 'FAILED');
                    assert.equal(task.errorCode, 'QUOTA_EXCEEDED');
                    const prefix =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        });
                    assert.equal(prefix.completedUnits, 32);
                    assert.equal(prefix.reservedBytes, 0n);
                    assert(prefix.storedBytes > 0n);
                    assert.equal(
                        await prisma.embeddingWorkAttempt.count({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        }),
                        1
                    );
                    assert.equal(
                        await prisma.chunk.count({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        }),
                        0
                    );
                    const calls = fixture.state.embedCalls;
                    await f.owner.rag.indexing.retry({
                        collectionId: collection.id,
                        taskId: task.id,
                    });
                    await scanSemantic(fixture, started.generationId, 2);
                    assert.equal(
                        (await candidateTask(started.generationId)).errorCode,
                        'QUOTA_EXCEEDED'
                    );
                    assert.equal(fixture.state.embedCalls, calls);
                    assert.equal(
                        await prisma.embeddingWorkAttempt.count({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        }),
                        1
                    );
                    assert.deepEqual(
                        (
                            await prisma.semanticChunkPlan.findUniqueOrThrow({
                                where: {
                                    indexedDocumentId: task.indexedDocumentId,
                                },
                            })
                        ).boundaryScores,
                        prefix.boundaryScores
                    );
                    await f.owner.rag.indexing.discard({
                        collectionId: collection.id,
                        generationId: started.generationId,
                    });
                    await scanSemantic(fixture, started.generationId, 6);
                    const plan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: task.indexedDocumentId,
                            },
                        });
                    assert.equal(plan.state, 'CLEANED');
                    assert.deepEqual(plan.unitRanges, []);
                    assert.deepEqual(plan.boundaryScores, []);
                    assert.equal(plan.finalRanges, null);
                    assert.equal(plan.lastUnitVector, null);
                    assert.equal(plan.storedBytes, 0n);
                    assert.equal(plan.reservedBytes, 0n);
                    assert.equal(plan.reservedPreparedBytes, 0n);
                    assert.equal(plan.reservedBatches, 0);
                    assert.equal(
                        (
                            await prisma.indexGeneration.findUniqueOrThrow({
                                where: { id: started.generationId },
                            })
                        ).status,
                        'CLEANED'
                    );
                    const history = await prisma.embeddingWorkAttempt.findMany({
                        where: { indexedDocumentId: task.indexedDocumentId },
                    });
                    assert.equal(history.length, 1);
                    assert.equal(history[0]!.dispatchedBatches, 1);
                    assert.equal(history[0]!.state, 'SUCCEEDED');
                    await prisma.organizationQuota.update({
                        where: { organizationId: f.org },
                        data: limits,
                    });
                }
            );

            await t.test(
                'late validated usage survives lease replacement while its stale result cannot advance the semantic cursor',
                async () => {
                    const collection =
                        await fixture.collection('Late lease usage');
                    await fixture.upload(
                        semanticText(40),
                        'late-lease.txt',
                        collection.id
                    );
                    const started = await f.owner.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await scanSemantic(fixture, started.generationId, 1);
                    const latch = semanticLatch();
                    fixture.state.beforeEmbedding = async () => {
                        delete fixture.state.beforeEmbedding;
                        await latch.block();
                    };
                    const running = scanSemantic(
                        fixture,
                        started.generationId,
                        1
                    );
                    let candidateId: string;
                    let workId: string;
                    try {
                        await latch.arrived();
                        const task = await candidateTask(started.generationId);
                        assert(task.indexedDocumentId);
                        candidateId = task.indexedDocumentId;
                        const work =
                            await prisma.embeddingWorkAttempt.findFirstOrThrow({
                                where: {
                                    indexedDocumentId: candidateId,
                                    state: 'IN_FLIGHT',
                                },
                            });
                        workId = work.id;
                        await prisma.indexTask.update({
                            where: { id: task.id },
                            data: {
                                leaseToken: randomUUID(),
                                leaseEpoch: { increment: 1 },
                                leasedUntil: new Date(0),
                            },
                        });
                    } finally {
                        latch.release();
                        delete fixture.state.beforeEmbedding;
                        await running;
                    }
                    const observed =
                        await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                            where: { id: workId },
                        });
                    assert.equal(observed.state, 'SUCCEEDED');
                    assert(observed.usageRecordedAt);
                    assert.equal(observed.successfulRequests, 1);
                    assert.equal(observed.reservedPreparedBytes, 0n);
                    assert.equal(
                        (
                            await prisma.semanticChunkPlan.findUniqueOrThrow({
                                where: { indexedDocumentId: candidateId },
                            })
                        ).completedUnits,
                        0
                    );
                    assert.equal(
                        await prisma.chunk.count({
                            where: { indexedDocumentId: candidateId },
                        }),
                        0
                    );
                    await scanSemantic(fixture, started.generationId, 6);
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: collection.id,
                            })
                        ).active?.id,
                        started.generationId
                    );
                    const accounting =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    await scanSemantic(fixture, started.generationId, 2);
                    const unchanged =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    assert.equal(
                        unchanged.observedSuccessfulRequests,
                        accounting.observedSuccessfulRequests
                    );
                    assert.equal(
                        unchanged.observedProviderInputTokens,
                        accounting.observedProviderInputTokens
                    );
                }
            );

            await t.test(
                'validated late usage commits after issuer membership removal, without checkpoint or publication, and a current manager can retry',
                async () => {
                    const collection = await fixture.collection(
                        'Revoked semantic principal'
                    );
                    await fixture.upload(
                        semanticText(12),
                        'revoked.txt',
                        collection.id
                    );
                    await f.owner.rag.collections.setGrant({
                        id: collection.id,
                        target: { type: 'member', id: f.managerMember },
                        permissions: {
                            read: true,
                            manageDocuments: true,
                            administer: false,
                        },
                    });
                    const started = await f.manager.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await scanSemantic(fixture, started.generationId, 1);
                    const latch = semanticLatch();
                    fixture.state.beforeEmbedding = async () => {
                        delete fixture.state.beforeEmbedding;
                        await latch.block();
                    };
                    const running = scanSemantic(
                        fixture,
                        started.generationId,
                        1
                    );
                    let candidateId: string;
                    try {
                        await latch.arrived();
                        const task = await candidateTask(started.generationId);
                        assert(task.indexedDocumentId);
                        candidateId = task.indexedDocumentId;
                        await f.owner.post('organization/remove-member', {
                            organizationId: f.org,
                            memberIdOrEmail: f.managerMember,
                        });
                    } finally {
                        latch.release();
                        delete fixture.state.beforeEmbedding;
                        await running;
                    }
                    const task = await candidateTask(started.generationId);
                    assert.equal(task.status, 'FAILED');
                    assert.equal(task.errorCode, 'ACCESS_REVOKED');
                    assert.equal(
                        (
                            await prisma.semanticChunkPlan.findUniqueOrThrow({
                                where: { indexedDocumentId: candidateId },
                            })
                        ).completedUnits,
                        0
                    );
                    const work =
                        await prisma.embeddingWorkAttempt.findFirstOrThrow({
                            where: { indexedDocumentId: candidateId },
                        });
                    assert.equal(work.state, 'SUCCEEDED');
                    assert(work.usageRecordedAt);
                    assert.equal(
                        await prisma.chunk.count({
                            where: { indexedDocumentId: candidateId },
                        }),
                        0
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: collection.id,
                            })
                        ).active,
                        null
                    );
                    await f.owner.rag.indexing.retry({
                        collectionId: collection.id,
                        taskId: task.id,
                    });
                    await scanSemantic(fixture, started.generationId, 4);
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: collection.id,
                            })
                        ).active?.id,
                        started.generationId
                    );
                    assert.equal(
                        (await candidateTask(started.generationId)).requestedBy,
                        f.users[0]
                    );
                }
            );
        } finally {
            await prisma.organizationQuota.update({
                where: { organizationId: f.org },
                data: limits,
            });
        }
    } finally {
        await fixture.close();
    }
}
