import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { reapSemanticWork, failSemanticWork } from '@routers/rag/semantic-work';
import {
    dispatchSemanticWork,
    settleSemanticWork,
} from '@routers/rag/semantic-work-ledger';
import { fixture as f } from './fixtures';
import {
    createSemanticFixture,
    candidateTask,
    scanSemantic,
    semanticText,
} from './semantic-fixtures';

/** Synthetic selected usage exercises persisted expired/live ledger rows; it is not an additional real provider request. */
export async function semanticLedgerTests(t: TestContext) {
    const fixture = await createSemanticFixture('expired ledger', true);
    try {
        await t.test(
            'deadline reaping, late native evidence and duplicate callbacks release capacity and record unknown usage exactly once',
            async () => {
                const collection = await fixture.collection();
                await fixture.upload(
                    semanticText(64),
                    'expired-ledger.txt',
                    collection.id
                );
                const started = await f.owner.rag.indexing.start({
                    collectionId: collection.id,
                    expectedRevision: 1,
                    requestId: randomUUID(),
                });
                await scanSemantic(fixture, started.generationId, 2);
                const pending = await candidateTask(started.generationId);
                assert(pending.indexedDocumentId);
                const candidateId = pending.indexedDocumentId;
                const token = randomUUID();
                const task = await prisma.indexTask.update({
                    where: { id: pending.id },
                    data: {
                        status: 'PROCESSING',
                        leaseEpoch: { increment: 1 },
                        leaseToken: token,
                        leasedUntil: new Date(Date.now() + 120_000),
                    },
                });
                const claim = {
                    id: task.id,
                    organizationId: task.organizationId,
                    collectionId: task.collectionId,
                    generationId: task.generationId,
                    leaseEpoch: task.leaseEpoch,
                    token,
                };
                const generation =
                    await prisma.indexGeneration.findUniqueOrThrow({
                        where: { id: task.generationId },
                    });
                const before =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                const plan = await prisma.semanticChunkPlan.findUniqueOrThrow({
                    where: { indexedDocumentId: candidateId },
                });
                const batch: Parameters<typeof settleSemanticWork>[2] = {
                    provider: 'OLLAMA',
                    model: 'fixture:latest',
                    modelIdentity: generation.modelIdentity,
                    kind: 'document',
                    ordinal: 0,
                    inputOffset: 0,
                    inputCount: 1,
                    preparedInputBytes: 8,
                    estimatedInputTokens: 2,
                    preparedInputHashVersion: 'sha256-json-strings-v1',
                    preparedInputHash: createHash('sha256')
                        .update(JSON.stringify(['evidence']))
                        .digest('hex'),
                };
                const result: Parameters<typeof settleSemanticWork>[3] = {
                    vectors: [[1, 2, 3]],
                    usage: {
                        requests: 1,
                        estimatedInputTokens: 2,
                        providerInputTokens: null,
                        billedInputTokens: null,
                    },
                };
                const context: Parameters<typeof settleSemanticWork>[0] = {
                    db: prisma,
                    claim,
                    task,
                    candidateId,
                    purpose: 'BOUNDARY',
                    operationKey: 'fixture:expired',
                };
                const now = Date.now();
                // A controlled crash-recovery INSERT, not an update of immutable work deadlines.
                const work = await runSerializableTransaction(
                    prisma,
                    async (tx) => {
                        await tx.semanticChunkPlan.update({
                            where: { indexedDocumentId: candidateId },
                            data: {
                                reservedPreparedBytes: { decrement: 8 },
                                reservedBatches: { decrement: 1 },
                                revision: { increment: 1 },
                            },
                        });
                        await tx.organizationEmbeddingAccounting.update({
                            where: { organizationId: f.org },
                            data: {
                                dispatchedPreparedBytes: { increment: 8 },
                                dispatchedBatches: { increment: 1 },
                                revision: { increment: 1 },
                            },
                        });
                        return await tx.embeddingWorkAttempt.create({
                            data: {
                                organizationId: f.org,
                                generationId: task.generationId,
                                indexedDocumentId: candidateId,
                                purpose: 'BOUNDARY',
                                operationKey: context.operationKey,
                                batchOrdinal: 0,
                                attemptNumber: 1,
                                inputHash: batch.preparedInputHash,
                                inputCount: 1,
                                preparedInputBytes: 8,
                                taskId: task.id,
                                leaseEpoch: task.leaseEpoch,
                                state: 'IN_FLIGHT',
                                reservedPreparedBytes: 8,
                                reservedBatches: 1,
                                dispatchedPreparedBytes: 8,
                                dispatchedBatches: 1,
                                createdAt: new Date(now - 2000),
                                dispatchStartedAt: new Date(now - 1500),
                                deadlineAt: new Date(now - 1000),
                            },
                        });
                    }
                );
                await reapSemanticWork(prisma);
                await reapSemanticWork(prisma);
                const expired =
                    await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                        where: { id: work.id },
                    });
                assert.equal(expired.state, 'UNCERTAIN');
                assert.equal(expired.reservedBatches, 0);
                assert(expired.uncertainAt);
                const reaped =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                assert.equal(
                    reaped.reservedPreparedBytes,
                    before.reservedPreparedBytes - 8n
                );
                assert.equal(
                    reaped.reservedBatches,
                    before.reservedBatches - 1n
                );
                assert.equal(
                    reaped.uncertainAttempts,
                    before.uncertainAttempts + 1n
                );
                let checkpointed = false;
                await assert.rejects(
                    settleSemanticWork(context, work.id, batch, result, () => {
                        checkpointed = true;
                        return Promise.resolve();
                    })
                );
                assert.equal(checkpointed, false);
                const observed =
                    await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                        where: { id: work.id },
                    });
                assert.equal(observed.state, 'SUCCEEDED');
                assert.equal(observed.providerInputTokens, null);
                assert.equal(observed.billedInputTokens, null);
                assert(observed.usageRecordedAt);
                assert.equal(
                    observed.uncertainAt?.getTime(),
                    expired.uncertainAt?.getTime()
                );
                const accounted =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                assert.equal(
                    accounted.reservedPreparedBytes,
                    reaped.reservedPreparedBytes
                );
                assert.equal(accounted.reservedBatches, reaped.reservedBatches);
                assert.equal(
                    accounted.uncertainAttempts,
                    before.uncertainAttempts
                );
                assert.equal(
                    accounted.observedSuccessfulRequests,
                    before.observedSuccessfulRequests + 1n
                );
                assert.equal(
                    accounted.observedEstimatedInputTokens,
                    before.observedEstimatedInputTokens + 2n
                );
                assert.equal(
                    accounted.unknownProviderTokenBatches,
                    before.unknownProviderTokenBatches + 1n
                );
                assert.equal(
                    accounted.unknownBilledTokenBatches,
                    before.unknownBilledTokenBatches + 1n
                );
                await assert.rejects(
                    settleSemanticWork(context, work.id, batch, result)
                );
                await reapSemanticWork(prisma);
                await runSerializableTransaction(prisma, (tx) =>
                    failSemanticWork(tx, work.id, f.org, 'PROVIDER_TIMEOUT')
                );
                await runSerializableTransaction(prisma, (tx) =>
                    failSemanticWork(tx, work.id, f.org, 'PROVIDER_REJECTED')
                );
                const duplicate =
                    await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                        { where: { organizationId: f.org } }
                    );
                assert.equal(
                    duplicate.observedSuccessfulRequests,
                    accounted.observedSuccessfulRequests
                );
                assert.equal(
                    duplicate.reservedPreparedBytes,
                    accounted.reservedPreparedBytes
                );
                assert.equal(
                    duplicate.reservedBatches,
                    accounted.reservedBatches
                );
                assert.equal(
                    duplicate.uncertainAttempts,
                    accounted.uncertainAttempts
                );
                assert.deepEqual(
                    (
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: { indexedDocumentId: candidateId },
                        })
                    ).boundaryScores,
                    plan.boundaryScores
                );
                await f.owner.rag.indexing.discard({
                    collectionId: collection.id,
                    generationId: started.generationId,
                });
                await scanSemantic(fixture, started.generationId, 6);
                assert.equal(
                    (
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: { indexedDocumentId: candidateId },
                        })
                    ).state,
                    'CLEANED'
                );
                assert.equal(
                    (
                        await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                            where: { id: work.id },
                        })
                    ).state,
                    'SUCCEEDED'
                );
            }
        );
        await t.test(
            'grant revocation commits valid usage without renewing a still-live exact claim or advancing its plan',
            async () => {
                const collection = await fixture.collection(
                    'Live revoked work claim'
                );
                await fixture.upload(
                    semanticText(64),
                    'live-revoked-ledger.txt',
                    collection.id
                );
                const role = await prisma.organizationRole.create({
                    data: {
                        id: randomUUID(),
                        organizationId: f.org,
                        role: `semantic_indexer_${randomUUID().replaceAll('-', '')}`,
                        permission: JSON.stringify({
                            ragCollection: ['manageDocuments'],
                        }),
                        createdAt: new Date(),
                    },
                });
                try {
                    await prisma.member.update({
                        where: { id: f.readerMember },
                        data: { role: role.role },
                    });
                    await f.owner.rag.collections.setGrant({
                        id: collection.id,
                        target: { type: 'member', id: f.readerMember },
                        permissions: {
                            read: false,
                            manageDocuments: true,
                            administer: false,
                        },
                    });
                    const started = await f.reader.rag.indexing.start({
                        collectionId: collection.id,
                        expectedRevision: 1,
                        requestId: randomUUID(),
                    });
                    await scanSemantic(fixture, started.generationId, 2);
                    const pending = await candidateTask(started.generationId);
                    assert(pending.indexedDocumentId);
                    assert.equal(pending.requestedBy, f.users[2]);
                    const candidateId = pending.indexedDocumentId;
                    const token = randomUUID();
                    const task = await prisma.indexTask.update({
                        where: { id: pending.id },
                        data: {
                            status: 'PROCESSING',
                            continuationPending: false,
                            leaseEpoch: { increment: 1 },
                            leaseToken: token,
                            leasedUntil: new Date(Date.now() + 120_000),
                        },
                    });
                    const generation =
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: started.generationId },
                        });
                    const claim = {
                        id: task.id,
                        organizationId: task.organizationId,
                        collectionId: task.collectionId,
                        generationId: task.generationId,
                        leaseEpoch: task.leaseEpoch,
                        token,
                    };
                    const context: Parameters<typeof settleSemanticWork>[0] = {
                        db: prisma,
                        claim,
                        task,
                        candidateId,
                        purpose: 'BOUNDARY',
                        operationKey: 'fixture:live-revocation',
                    };
                    const batch: Parameters<typeof settleSemanticWork>[2] = {
                        provider: 'OLLAMA',
                        model: 'fixture:latest',
                        modelIdentity: generation.modelIdentity,
                        kind: 'document',
                        ordinal: 0,
                        inputOffset: 0,
                        inputCount: 1,
                        preparedInputBytes: 8,
                        estimatedInputTokens: 2,
                        preparedInputHashVersion: 'sha256-json-strings-v1',
                        preparedInputHash: createHash('sha256')
                            .update(JSON.stringify(['evidence']))
                            .digest('hex'),
                    };
                    const result: Parameters<typeof settleSemanticWork>[3] = {
                        vectors: [[1, 2, 3]],
                        usage: {
                            requests: 1,
                            estimatedInputTokens: 2,
                            providerInputTokens: 2,
                            billedInputTokens: 1.5,
                        },
                    };
                    const workId = await dispatchSemanticWork(context, batch);
                    // Keep the exact claim live with a shorter, unmistakable deadline. This
                    // changes only the task lease; the work's immutable deadline is untouched.
                    const beforeTask = await prisma.indexTask.update({
                        where: { id: task.id },
                        data: { leasedUntil: new Date(Date.now() + 20_000) },
                    });
                    const beforePlan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: { indexedDocumentId: candidateId },
                        });
                    const beforeUsage =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    await f.owner.rag.collections.removeGrant({
                        id: collection.id,
                        target: { type: 'member', id: f.readerMember },
                    });
                    assert(
                        beforeTask.leasedUntil &&
                            beforeTask.leasedUntil > new Date()
                    );
                    let checkpointed = false;
                    await assert.rejects(
                        settleSemanticWork(
                            context,
                            workId,
                            batch,
                            result,
                            () => {
                                checkpointed = true;
                                return Promise.resolve();
                            }
                        ),
                        { code: 'ACCESS_REVOKED' }
                    );
                    assert.equal(checkpointed, false);
                    const afterTask = await prisma.indexTask.findUniqueOrThrow({
                        where: { id: task.id },
                    });
                    assert.equal(
                        afterTask.leasedUntil?.getTime(),
                        beforeTask.leasedUntil.getTime()
                    );
                    assert.equal(afterTask.leaseToken, beforeTask.leaseToken);
                    assert.equal(afterTask.leaseEpoch, beforeTask.leaseEpoch);
                    assert.equal(afterTask.status, 'PROCESSING');
                    const afterPlan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: { indexedDocumentId: candidateId },
                        });
                    assert.equal(
                        afterPlan.completedUnits,
                        beforePlan.completedUnits
                    );
                    assert.deepEqual(
                        afterPlan.boundaryScores,
                        beforePlan.boundaryScores
                    );
                    assert.equal(
                        await prisma.chunk.count({
                            where: { indexedDocumentId: candidateId },
                        }),
                        0
                    );
                    const settled =
                        await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                            where: { id: workId },
                        });
                    assert.equal(settled.state, 'SUCCEEDED');
                    assert(settled.usageRecordedAt);
                    const afterUsage =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    assert.equal(
                        afterUsage.observedSuccessfulRequests,
                        beforeUsage.observedSuccessfulRequests + 1n
                    );
                    assert.equal(
                        afterUsage.observedProviderInputTokens,
                        beforeUsage.observedProviderInputTokens + 2n
                    );
                    assert.equal(
                        afterUsage.observedBilledInputTokens,
                        beforeUsage.observedBilledInputTokens + 1.5
                    );
                    assert.equal(
                        afterUsage.reservedPreparedBytes,
                        beforeUsage.reservedPreparedBytes - 8n
                    );
                    assert.equal(
                        afterUsage.reservedBatches,
                        beforeUsage.reservedBatches - 1n
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: collection.id,
                            })
                        ).active,
                        null
                    );
                    await f.owner.rag.indexing.discard({
                        collectionId: collection.id,
                        generationId: started.generationId,
                    });
                    await scanSemantic(fixture, started.generationId, 6);
                } finally {
                    await prisma.member.update({
                        where: { id: f.readerMember },
                        data: { role: 'member' },
                    });
                    await prisma.organizationRole.delete({
                        where: { id: role.id },
                    });
                }
            }
        );
    } finally {
        await fixture.close();
    }
}
