import type { IndexTask, PrismaClient } from '@repo/db';
import { manifestHash } from '@repo/vector-store';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { generationVectorAdapter } from './generation-adapter';
import { accountPurgedCandidate } from './accounting';
import { releaseSourceHold } from './source-holds';
import { purgeSemanticPlan } from './semantic-work';
import {
    acknowledgeGenerationChange,
    retireIndexedDocument,
} from './publication-state';
import {
    renewIndexClaim,
    completeIndexClaim,
    type IndexClaim,
    IndexingError,
} from './task-state';

async function deferCleanup(
    db: PrismaClient,
    claim: IndexClaim,
    until: Date,
    stage = 'WAITING_FOR_SOURCES'
) {
    await db.indexTask.updateMany({
        where: {
            id: claim.id,
            leaseToken: claim.token,
            leaseEpoch: claim.leaseEpoch,
            status: 'PROCESSING',
        },
        data: {
            status: 'PENDING',
            stage,
            availableAt: until,
            leaseToken: null,
            leasedUntil: null,
        },
    });
}

/** Physical vector tombstones precede chunk/quota/hold release; an extended citation hold postpones destructive claims. */
export async function executePublicationCleanup(
    db: PrismaClient,
    claim: IndexClaim,
    task: IndexTask
) {
    if (!task.indexedDocumentId) return;
    const candidateId = task.indexedDocumentId;
    const prepared = await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim, 'CLEANING');
        // Lock the same generation before its candidate as signed-source renewal.
        await tx.indexGeneration.update({
            where: { id: claim.generationId },
            data: { updatedAt: new Date() },
        });
        const candidate = await tx.indexedDocument.findUniqueOrThrow({
            where: { id: candidateId },
            include: { sourceHold: true },
        });
        if (candidate.status === 'CLEANED') {
            await completeIndexClaim(tx, claim);
            return { done: true as const };
        }
        if (
            candidate.sourceHold?.state === 'RETIRED' &&
            candidate.sourceHold.retainUntil! > new Date()
        )
            return { wait: candidate.sourceHold.retainUntil! };
        if (candidate.status === 'RETIRED')
            await tx.indexedDocument.update({
                where: { id: candidateId },
                data: { status: 'CLEANING' },
            });
        else if (candidate.status !== 'CLEANING')
            return { wait: new Date(Date.now() + 5000) };
        return { candidate };
    });
    if ('done' in prepared) return;
    if ('wait' in prepared) {
        await deferCleanup(db, claim, prepared.wait!);
        return;
    }
    const candidate = prepared.candidate;
    if (
        candidate.chunkCount > 0 &&
        candidate.materializedChunks === candidate.chunkCount
    ) {
        const rows = await db.chunk.findMany({
            where: { indexedDocumentId: candidateId, kind: 'CHILD' },
            orderBy: { ordinal: 'asc' },
            select: { id: true, ordinal: true, textHash: true },
            take: 100_001,
        });
        const hash =
            candidate.manifestHash ??
            manifestHash(
                rows.map((row) => ({
                    chunkId: row.id,
                    ordinal: row.ordinal,
                    chunkHash: row.textHash,
                }))
            );
        const binding = await generationVectorAdapter(
            db,
            claim.organizationId,
            claim.generationId
        );
        await binding.store.tombstone(binding.spec, {
            id: candidateId,
            documentId: candidate.documentId,
            sourceVersionId: candidate.sourceVersionId,
            expectedCount: candidate.chunkCount,
            manifestHash: hash,
        });
    }
    const released = await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim, 'RELEASING');
        if (!(await purgeSemanticPlan(tx, candidateId))) return false;
        await accountPurgedCandidate(tx, {
            collectionId: claim.collectionId,
            candidateId,
        });
        await releaseSourceHold(tx, {
            organizationId: claim.organizationId,
            indexedDocumentId: candidateId,
        });
        await completeIndexClaim(tx, claim);
        return true;
    });
    if (!released)
        await deferCleanup(
            db,
            claim,
            new Date(Date.now() + 5000),
            'WAITING_FOR_EMBEDDING_WORK'
        );
}

/** Removal hides current sources immediately; retained vector publications are cleaned only through their fenced tasks. */
export async function executeDocumentRemoval(
    db: PrismaClient,
    claim: IndexClaim,
    task: IndexTask
) {
    await runSerializableTransaction(
        db,
        async (tx) => {
            await renewIndexClaim(tx, claim, 'REMOVING');
            const change =
                task.changeSequence === null
                    ? null
                    : await tx.collectionChange.findUnique({
                          where: {
                              ['organizationId_collectionId_sequence']: {
                                  organizationId: claim.organizationId,
                                  collectionId: claim.collectionId,
                                  sequence: task.changeSequence,
                              },
                          },
                      });
            let removed = false;
            if (change?.documentId) {
                const desired = await tx.generationDocument.findUnique({
                    where: {
                        ['generationId_documentId']: {
                            generationId: claim.generationId,
                            documentId: change.documentId,
                        },
                    },
                });
                if (
                    desired &&
                    desired.desiredChangeSequence === task.changeSequence &&
                    desired.removedAt
                ) {
                    removed = true;
                    const candidates = await tx.indexedDocument.findMany({
                        where: {
                            generationId: claim.generationId,
                            documentId: change.documentId,
                            status: { notIn: ['CLEANED', 'CLEANING'] },
                        },
                    });
                    for (const candidate of candidates)
                        await retireIndexedDocument(
                            tx,
                            candidate,
                            task.requestedBy,
                            true
                        );
                    await tx.generationDocument.update({
                        where: {
                            ['generationId_documentId']: {
                                generationId: claim.generationId,
                                documentId: change.documentId,
                            },
                        },
                        data: {
                            publishedIndexedDocumentId: null,
                            targetChunkCount: 0,
                        },
                    });
                    await tx.indexGeneration.update({
                        where: { id: claim.generationId },
                        data: {
                            projectedChunks: {
                                decrement: desired.targetChunkCount,
                            },
                        },
                    });
                }
            }
            await acknowledgeGenerationChange(
                tx,
                claim.generationId,
                task.changeSequence,
                removed ? 'REMOVED' : 'SUPERSEDED'
            );
            await completeIndexClaim(tx, claim);
        },
        { timeout: 30_000 }
    );
}

/** Drop a destination only after all fenced publication cleanup has acknowledged physical removal. */
export async function executeGenerationCleanup(
    db: PrismaClient,
    claim: IndexClaim,
    task: IndexTask
) {
    const prepared = await runSerializableTransaction(
        db,
        async (tx) => {
            await renewIndexClaim(tx, claim, 'RETIRING_GENERATION');
            // Collection writes serialize activation/deletion; the generation write
            // also serializes a retired generation's last citation renewal.
            const collection = await tx.collection.update({
                where: { id: claim.collectionId },
                data: { contentSequence: { increment: 0 } },
            });
            const generation = await tx.indexGeneration.update({
                where: { id: claim.generationId },
                data: { updatedAt: new Date() },
            });
            if (generation.status === 'CLEANED') {
                await completeIndexClaim(tx, claim);
                return { done: true as const };
            }
            if (
                (generation.status === 'ACTIVE' ||
                    collection.activeGenerationId === generation.id) &&
                !collection.deletedAt
            )
                throw new IndexingError('GENERATION_CONFLICT');
            if (generation.status === 'RETIRED') {
                const held = await tx.documentSourceHold.aggregate({
                    where: {
                        organizationId: claim.organizationId,
                        indexedDocument: { generationId: generation.id },
                        state: 'RETIRED',
                    },
                    _max: { retainUntil: true },
                });
                const deadline = new Date(
                    Math.max(
                        generation.cleanupAfter?.getTime() ?? 0,
                        held._max.retainUntil?.getTime() ?? 0
                    )
                );
                if (deadline > new Date()) return { wait: deadline };
            }
            if (collection.activeGenerationId === generation.id) {
                const accounting =
                    await tx.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: claim.collectionId },
                    });
                await tx.collectionIndexAccounting.update({
                    where: { collectionId: claim.collectionId },
                    data: {
                        activeChunks: 0,
                        retainedChunks: { increment: accounting.activeChunks },
                        revision: { increment: 1 },
                    },
                });
                await tx.collection.update({
                    where: { id: claim.collectionId },
                    data: { activeGenerationId: null },
                });
            }
            await tx.indexGeneration.update({
                where: { id: generation.id },
                data: {
                    status: 'CLEANING',
                    projectedChunks: 0,
                    retiredAt: generation.retiredAt ?? new Date(),
                },
            });
            const candidates = await tx.indexedDocument.findMany({
                where: {
                    generationId: generation.id,
                    status: { in: ['STAGING', 'SEALED', 'PUBLISHED'] },
                },
                orderBy: { id: 'asc' },
                take: 100,
            });
            // A serving generation already had a grace at the atomic switch;
            // a discarded candidate never served searches. Honor either accepted
            // deadline rather than manufacturing a fresh citation grace.
            const absoluteDeadline = generation.cleanupAfter ?? undefined;
            for (const candidate of candidates)
                await retireIndexedDocument(
                    tx,
                    candidate,
                    task.requestedBy,
                    true,
                    absoluteDeadline
                );
            await tx.generationDocument.updateMany({
                where: { generationId: generation.id },
                data: {
                    desiredVersionId: null,
                    desiredExtractionId: null,
                    desiredMetadataRevision: 0,
                    publishedIndexedDocumentId: null,
                    targetChunkCount: 0,
                    removedAt: new Date(),
                },
            });
            await tx.indexTask.updateMany({
                where: {
                    generationId: generation.id,
                    kind: {
                        in: ['PROVISION', 'INDEX_DOCUMENT', 'REMOVE_DOCUMENT'],
                    },
                    status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
                },
                data: {
                    status: 'CANCELLED',
                    stage: collection.deletedAt
                        ? 'GENERATION_DELETED'
                        : 'GENERATION_DISCARDED',
                    leaseToken: null,
                    leasedUntil: null,
                    leaseEpoch: { increment: 1 },
                },
            });
            const effect = collection.deletedAt
                ? ('COLLECTION_DELETED' as const)
                : ('SUPERSEDED' as const);
            await tx.generationChange.updateMany({
                where: { generationId: generation.id, status: 'PENDING' },
                data: { status: 'APPLIED', effect, appliedAt: new Date() },
            });
            await acknowledgeGenerationChange(
                tx,
                generation.id,
                task.changeSequence,
                effect
            );
            return { ready: true as const };
        },
        { timeout: 30_000 }
    );
    if ('done' in prepared) return;
    if ('wait' in prepared) {
        await deferCleanup(db, claim, prepared.wait!);
        return;
    }
    if (
        await db.indexedDocument.count({
            where: {
                generationId: claim.generationId,
                status: { not: 'CLEANED' },
            },
        })
    ) {
        await deferCleanup(db, claim, new Date(Date.now() + 5000));
        return;
    }
    const binding = await generationVectorAdapter(
        db,
        claim.organizationId,
        claim.generationId,
        { provision: true }
    );
    await binding.store.drop(binding.spec);
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim, 'DROPPING_GENERATION');
        await tx.indexGeneration.update({
            where: { id: claim.generationId },
            data: { status: 'CLEANED' },
        });
        await completeIndexClaim(tx, claim);
    });
}
