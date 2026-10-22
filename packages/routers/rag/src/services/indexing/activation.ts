import type {
    IndexGeneration,
    IndexTask,
    Prisma,
    PrismaClient,
} from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { acknowledgeGenerationChange } from './publication-state';
import { indexErrorCode } from './task-state';
import { requireSynchronizationActivationAuthority } from './sync-authority';
import { retireGenerationSourceHolds } from './source-holds';
import { SOURCE_RETIRE_GRACE_MS } from './source-retention';
import { MAX_INDEXED_DOCUMENTS_PER_COLLECTION } from './limits';

async function activationFailure(
    tx: Prisma.TransactionClient,
    generation: IndexGeneration,
    principal: IndexTask,
    code: 'ACCESS_REVOKED' | 'GENERATION_CONFLICT'
) {
    await tx.indexTask.update({
        where: { id: principal.id },
        data: {
            status: 'FAILED',
            stage: 'ACTIVATION',
            errorCode: code,
            completedAt: null,
        },
    });
    await tx.indexGeneration.update({
        where: { id: generation.id },
        data: { lastErrorCode: code },
    });
}

/**
 * Switch only a complete, contiguous immutable snapshot under the collection
 * mutation fence. A replaced generation retains its manifests and source pins
 * until captured searches and signed-source receipts have finished their grace.
 */
export async function activateReadyGenerations(db: PrismaClient) {
    const candidates = await db.indexGeneration.findMany({
        where: {
            status: { in: ['BUILDING', 'ACTIVE'] },
            collection: { deletedAt: null },
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, collectionId: true },
        take: 10,
    });
    for (const candidate of candidates)
        await runSerializableTransaction(
            db,
            async (tx) => {
                const collection = await tx.collection.update({
                    where: { id: candidate.collectionId },
                    data: { contentSequence: { increment: 0 } },
                });
                const generation = await tx.indexGeneration.findUniqueOrThrow({
                    where: { id: candidate.id },
                });
                if (
                    !['BUILDING', 'ACTIVE'].includes(generation.status) ||
                    collection.deletedAt
                )
                    return;
                await acknowledgeGenerationChange(
                    tx,
                    generation.id,
                    null,
                    'PUBLISHED'
                );
                // Rotate bounded scans even when an active generation closes a large receipt gap.
                await tx.indexGeneration.update({
                    where: { id: generation.id },
                    data: { updatedAt: new Date() },
                });
                if (generation.status === 'ACTIVE') return;
                if (
                    await tx.indexTask.count({
                        where: {
                            generationId: generation.id,
                            status: 'FAILED',
                            stage: 'ACTIVATION',
                        },
                    })
                )
                    return;
                const principal = await tx.indexTask.findFirst({
                    where: {
                        generationId: generation.id,
                        status: 'COMPLETE',
                        kind: { in: ['PROVISION', 'INDEX_DOCUMENT'] },
                    },
                    orderBy: [{ completedAt: 'desc' }, { updatedAt: 'desc' }],
                });
                if (!principal) return;
                if (
                    collection.activeGenerationId !==
                        generation.previousGenerationId ||
                    collection.configurationRevision !==
                        generation.configurationRevision
                ) {
                    await activationFailure(
                        tx,
                        generation,
                        principal,
                        'GENERATION_CONFLICT'
                    );
                    return;
                }
                const refreshed = await tx.indexGeneration.findUniqueOrThrow({
                    where: { id: generation.id },
                });
                if (refreshed.appliedSequence !== collection.contentSequence)
                    return;
                const documents = await tx.generationDocument.findMany({
                    where: {
                        generationId: generation.id,
                        removedAt: null,
                        desiredVersionId: { not: null },
                    },
                    select: {
                        desiredVersionId: true,
                        desiredExtractionId: true,
                        desiredMetadataRevision: true,
                        publishedIndexedDocument: {
                            select: {
                                status: true,
                                sourceVersionId: true,
                                extractionId: true,
                                metadataRevision: true,
                                materializedChunks: true,
                            },
                        },
                    },
                    take: MAX_INDEXED_DOCUMENTS_PER_COLLECTION + 1,
                });
                if (
                    documents.length > MAX_INDEXED_DOCUMENTS_PER_COLLECTION ||
                    documents.some((document) => {
                        const publication = document.publishedIndexedDocument;
                        return (
                            !publication ||
                            publication.status !== 'PUBLISHED' ||
                            publication.sourceVersionId !==
                                document.desiredVersionId ||
                            publication.extractionId !==
                                document.desiredExtractionId ||
                            publication.metadataRevision !==
                                document.desiredMetadataRevision
                        );
                    })
                )
                    return;
                try {
                    await requireSynchronizationActivationAuthority(
                        tx,
                        generation,
                        principal
                    );
                } catch (error) {
                    if (indexErrorCode(error) !== 'ACCESS_REVOKED') throw error;
                    await activationFailure(
                        tx,
                        generation,
                        principal,
                        'ACCESS_REVOKED'
                    );
                    return;
                }
                const now = new Date();
                const deadline = new Date(
                    now.getTime() + SOURCE_RETIRE_GRACE_MS
                );
                if (generation.previousGenerationId) {
                    const retired = await tx.indexGeneration.updateMany({
                        where: {
                            id: generation.previousGenerationId,
                            organizationId: generation.organizationId,
                            collectionId: collection.id,
                            status: 'ACTIVE',
                        },
                        data: {
                            status: 'RETIRED',
                            retiredAt: now,
                            cleanupAfter: deadline,
                        },
                    });
                    if (!retired.count) {
                        await activationFailure(
                            tx,
                            generation,
                            principal,
                            'GENERATION_CONFLICT'
                        );
                        return;
                    }
                    await retireGenerationSourceHolds(tx, {
                        organizationId: generation.organizationId,
                        generationId: generation.previousGenerationId,
                        retainUntil: deadline,
                    });
                    await tx.indexTask.updateMany({
                        where: {
                            generationId: generation.previousGenerationId,
                            kind: {
                                in: [
                                    'PROVISION',
                                    'INDEX_DOCUMENT',
                                    'REMOVE_DOCUMENT',
                                ],
                            },
                            status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
                        },
                        data: {
                            status: 'CANCELLED',
                            stage: 'GENERATION_REPLACED',
                            leaseToken: null,
                            leasedUntil: null,
                            leaseEpoch: { increment: 1 },
                        },
                    });
                    await tx.indexTask.upsert({
                        where: {
                            ['organizationId_dedupeKey']: {
                                organizationId: generation.organizationId,
                                dedupeKey: `clean-generation:${generation.previousGenerationId}`,
                            },
                        },
                        create: {
                            organizationId: generation.organizationId,
                            collectionId: collection.id,
                            generationId: generation.previousGenerationId,
                            kind: 'CLEAN_GENERATION',
                            dedupeKey: `clean-generation:${generation.previousGenerationId}`,
                            requestedBy:
                                generation.authorityUserId ??
                                generation.createdBy,
                            availableAt: deadline,
                        },
                        update: {},
                    });
                }
                const active = BigInt(
                    documents.reduce(
                        (sum, document) =>
                            sum +
                            document.publishedIndexedDocument!
                                .materializedChunks,
                        0
                    )
                );
                const accounting =
                    await tx.collectionIndexAccounting.findUniqueOrThrow({
                        where: { collectionId: collection.id },
                    });
                await tx.collectionIndexAccounting.update({
                    where: { collectionId: collection.id },
                    data: {
                        activeChunks: active,
                        retainedChunks: {
                            increment: accounting.activeChunks - active,
                        },
                        revision: { increment: 1 },
                    },
                });
                await tx.indexGeneration.update({
                    where: { id: generation.id },
                    data: {
                        status: 'ACTIVE',
                        activatedAt: now,
                        lastErrorCode: null,
                    },
                });
                await tx.collection.update({
                    where: { id: collection.id },
                    data: { activeGenerationId: generation.id },
                });
                await tx.ragAuditLog.create({
                    data: {
                        organizationId: generation.organizationId,
                        actorType: 'worker',
                        actorId: 'indexing',
                        action: 'collection.index.activated',
                        targetId: collection.id,
                        details: {
                            generationId: generation.id,
                            previousGenerationId:
                                generation.previousGenerationId,
                            chunks: Number(active),
                        },
                    },
                });
            },
            { timeout: 30_000 }
        );
}
