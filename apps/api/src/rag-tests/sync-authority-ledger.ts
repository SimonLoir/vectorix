import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { prisma } from '@repo/db';
import {
    dispatchSemanticWork,
    settleSemanticWork,
} from '@routers/rag/semantic-work-ledger';
import { failSemanticWork } from '@routers/rag/semantic-work';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { fixture as f } from './fixtures';
import { parentProfile } from './parent-fixtures';
import { semanticText } from './semantic-fixtures';
import {
    createSyncFixture,
    currentSyncTask,
    replaceSyncSource,
    scanSync,
    startSyncCollection,
    syncManageGrant,
    syncReadGrant,
} from './sync-authority-fixtures';

/** Selected synthetic evidence isolates the live-lease settlement boundary; separate paused HTTP journeys prove actual native response accounting. */
export async function syncAuthorityLedgerTests(t: TestContext) {
    for (const pendingRebuild of [false, true])
        await t.test(
            `late known semantic usage survives ${pendingRebuild ? 'pending rebuild administrator-only' : 'ACTIVE management'} revocation without renewing the live claim or accepting a checkpoint`,
            async () => {
                const fixture = await createSyncFixture(
                    `Live ${pendingRebuild ? 'rebuild' : 'active'} usage denial`
                );
                try {
                    const entry = await startSyncCollection(fixture, {
                        name: 'Exact live claim revocation',
                        strategy: 'SEMANTIC',
                        text: semanticText(64),
                    });
                    let generationId = entry.generationId;
                    if (pendingRebuild) {
                        await f.owner.rag.collections.update({
                            id: entry.collection.id,
                            expectedRevision: 1,
                            name: entry.collection.name,
                            description: '',
                            profile: parentProfile('SEMANTIC', 256),
                        });
                        generationId = (
                            await f.owner.rag.indexing.rebuild({
                                collectionId: entry.collection.id,
                                expectedRevision: 2,
                                expectedActiveGenerationId: entry.generationId,
                                requestId: randomUUID(),
                            })
                        ).generationId;
                        await scanSync(fixture, [generationId], 2);
                    } else {
                        await replaceSyncSource(
                            fixture,
                            entry.documentId,
                            `${semanticText(64)}\nActive live replacement.`
                        );
                        await scanSync(fixture, [generationId], 1);
                    }
                    const pending = await currentSyncTask(
                        generationId,
                        entry.documentId
                    );
                    assert.equal(pending.status, 'PENDING');
                    assert(pending.indexedDocumentId);
                    const task = await prisma.indexTask.update({
                        where: { id: pending.id },
                        data: {
                            status: 'PROCESSING',
                            continuationPending: false,
                            leaseEpoch: { increment: 1 },
                            leaseToken: randomUUID(),
                            leasedUntil: new Date(Date.now() + 120_000),
                        },
                    });
                    assert(task.leaseToken);
                    const generation =
                        await prisma.indexGeneration.findUniqueOrThrow({
                            where: { id: generationId },
                        });
                    const context: Parameters<typeof settleSemanticWork>[0] = {
                        db: prisma,
                        claim: {
                            id: task.id,
                            organizationId: f.org,
                            collectionId: entry.collection.id,
                            generationId,
                            token: task.leaseToken,
                            leaseEpoch: task.leaseEpoch,
                        },
                        task,
                        candidateId: pending.indexedDocumentId,
                        purpose: 'BOUNDARY',
                        operationKey: `fixture:sync-${pendingRebuild ? 'rebuild' : 'active'}`,
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
                            billedInputTokens: null,
                        },
                    };
                    const workId = await dispatchSemanticWork(context, batch);
                    // Only the task's mutable live lease is shortened to expose an unwanted renewal; the immutable work deadline is unchanged.
                    const beforeTask = await prisma.indexTask.update({
                        where: { id: task.id },
                        data: { leasedUntil: new Date(Date.now() + 20_000) },
                    });
                    const beforePlan =
                        await prisma.semanticChunkPlan.findUniqueOrThrow({
                            where: {
                                indexedDocumentId: pending.indexedDocumentId,
                            },
                        });
                    const beforeUsage =
                        await prisma.organizationEmbeddingAccounting.findUniqueOrThrow(
                            { where: { organizationId: f.org } }
                        );
                    await f.owner.rag.collections.setGrant({
                        id: entry.collection.id,
                        target: { type: 'member', id: f.ownerMember },
                        permissions: pendingRebuild
                            ? syncManageGrant
                            : syncReadGrant,
                    });
                    let checkpoints = 0;
                    for (let call = 0; call < 2; call++)
                        await assert.rejects(
                            settleSemanticWork(
                                context,
                                workId,
                                batch,
                                result,
                                () => {
                                    checkpoints++;
                                    return Promise.resolve();
                                }
                            ),
                            { code: 'ACCESS_REVOKED' }
                        );
                    await runSerializableTransaction(prisma, (tx) =>
                        failSemanticWork(
                            tx,
                            workId,
                            f.org,
                            'PROVIDER_UNAVAILABLE'
                        )
                    );
                    assert.equal(checkpoints, 0);
                    const afterTask = await prisma.indexTask.findUniqueOrThrow({
                        where: { id: task.id },
                    });
                    assert.ok(
                        isDeepStrictEqual(afterTask, beforeTask),
                        'Known denied usage must not mutate or renew the exact live task claim.'
                    );
                    assert.ok(
                        isDeepStrictEqual(
                            await prisma.semanticChunkPlan.findUniqueOrThrow({
                                where: {
                                    indexedDocumentId:
                                        pending.indexedDocumentId,
                                },
                            }),
                            beforePlan
                        ),
                        'A denied result must not advance or alter the saved plan.'
                    );
                    const work =
                        await prisma.embeddingWorkAttempt.findUniqueOrThrow({
                            where: { id: workId },
                        });
                    assert.equal(work.state, 'SUCCEEDED');
                    assert(work.usageRecordedAt);
                    assert.equal(work.reservedPreparedBytes, 0n);
                    assert.equal(work.reservedBatches, 0);
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
                        afterUsage.reservedPreparedBytes,
                        beforeUsage.reservedPreparedBytes - 8n
                    );
                    assert.equal(
                        afterUsage.reservedBatches,
                        beforeUsage.reservedBatches - 1n
                    );
                    assert.equal(
                        await prisma.chunk.count({
                            where: {
                                indexedDocumentId: pending.indexedDocumentId,
                            },
                        }),
                        0
                    );
                    assert.equal(
                        (
                            await f.owner.rag.indexing.status({
                                collectionId: entry.collection.id,
                            })
                        ).active?.id,
                        entry.generationId
                    );
                } finally {
                    await fixture.close();
                }
            }
        );
}
