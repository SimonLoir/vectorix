import type { IndexTask, PrismaClient } from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    initializeVectorDestination,
    generationVectorAdapter,
} from './generation-adapter';
import { executeDocumentIndex } from './index-document';
import {
    executeDocumentRemoval,
    executeGenerationCleanup,
    executePublicationCleanup,
} from './cleanup-index';
import {
    acknowledgeGenerationChange,
    CandidateObsolete,
    retireIndexedDocument,
} from './publication-state';
import {
    claimIndexTask,
    completeIndexClaim,
    failIndexClaim,
    renewIndexClaim,
    requireIndexAuthority,
    type IndexClaim,
    IndexingError,
} from './task-state';

/** PostgreSQL is the source of task state; Redis only schedules bounded scans without content or secrets. */
export async function processCollectionIndexing(db: PrismaClient) {
    // Bootstrap may be absent in a notification-only deployment. Durable indexing
    // claims below report safe errors; other worker queues continue independently.
    await initializeVectorDestination().catch(() => {});
    const tasks = await db.indexTask.findMany({
        where: {
            availableAt: { lte: new Date() },
            AND: [
                {
                    OR: [
                        { status: 'PENDING' },
                        {
                            status: 'PROCESSING',
                            leasedUntil: { lte: new Date() },
                        },
                    ],
                },
                {
                    OR: [
                        { kind: { not: 'INDEX_DOCUMENT' } },
                        {
                            generation: {
                                status: { in: ['BUILDING', 'ACTIVE'] },
                            },
                        },
                    ],
                },
            ],
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 10,
    });
    for (const task of tasks) {
        const claim = await claimIndexTask(db, task);
        if (!claim) continue;
        try {
            switch (task.kind) {
                case 'PROVISION': {
                    await provision(db, claim, task);
                    break;
                }
                case 'INDEX_DOCUMENT': {
                    await executeDocumentIndex(db, claim, task);
                    break;
                }
                case 'REMOVE_DOCUMENT': {
                    await executeDocumentRemoval(db, claim, task);
                    break;
                }
                case 'CLEAN_PUBLICATION': {
                    await executePublicationCleanup(db, claim, task);
                    break;
                }
                case 'CLEAN_GENERATION':
                    {
                        await executeGenerationCleanup(db, claim, task);
                        // No default
                    }
                    break;
            }
        } catch (error) {
            await (error instanceof CandidateObsolete
                ? supersede(db, claim, task)
                : failIndexClaim(db, claim, error));
        }
    }
    await activateReadyGenerations(db);
}

async function provision(db: PrismaClient, claim: IndexClaim, task: IndexTask) {
    await renewIndexClaim(db, claim, 'PROVISIONING');
    await requireIndexAuthority(db, task);
    const binding = await generationVectorAdapter(
        db,
        claim.organizationId,
        claim.generationId,
        { provision: true }
    );
    await binding.store.provision(binding.spec);
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim);
        await requireIndexAuthority(tx, task);
        await tx.indexGeneration.updateMany({
            where: {
                id: claim.generationId,
                status: 'PROVISIONING',
                collection: { deletedAt: null },
            },
            data: { status: 'BUILDING', lastErrorCode: null },
        });
        await completeIndexClaim(tx, claim);
    });
}

async function supersede(db: PrismaClient, claim: IndexClaim, task: IndexTask) {
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim);
        if (task.indexedDocumentId) {
            const candidate = await tx.indexedDocument.findUnique({
                where: { id: task.indexedDocumentId },
            });
            if (candidate)
                await retireIndexedDocument(
                    tx,
                    candidate,
                    task.requestedBy,
                    true
                );
        }
        await acknowledgeGenerationChange(
            tx,
            claim.generationId,
            task.changeSequence,
            'SUPERSEDED'
        );
        await tx.indexTask.update({
            where: { id: task.id },
            data: {
                status: 'CANCELLED',
                stage: 'SUPERSEDED',
                leaseToken: null,
                leasedUntil: null,
            },
        });
    });
}

/** Activate a complete first generation under the same collection fence as accepted changes. */
async function activateReadyGenerations(db: PrismaClient) {
    const candidates = await db.indexGeneration.findMany({
        where: {
            status: { in: ['BUILDING', 'ACTIVE'] },
            collection: { deletedAt: null },
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: 10,
    });
    for (const candidate of candidates)
        await runSerializableTransaction(
            db,
            async (tx) => {
                const generation = await tx.indexGeneration.findUniqueOrThrow({
                    where: { id: candidate.id },
                });
                if (!['BUILDING', 'ACTIVE'].includes(generation.status)) return;
                await acknowledgeGenerationChange(
                    tx,
                    generation.id,
                    null,
                    'PUBLISHED'
                );
                // A bounded scan keeps an ACTIVE generation moving after a large
                // previously blocked receipt gap closes without future mutations.
                await tx.indexGeneration.update({
                    where: { id: generation.id },
                    data: { updatedAt: new Date() },
                });
                if (generation.status === 'ACTIVE') return;
                const collection = await tx.collection.update({
                    where: { id: generation.collectionId },
                    data: { contentSequence: { increment: 0 } },
                });
                if (
                    collection.deletedAt ||
                    collection.activeGenerationId ||
                    collection.configurationRevision !==
                        generation.configurationRevision
                )
                    return;
                await acknowledgeGenerationChange(
                    tx,
                    generation.id,
                    null,
                    'PUBLISHED'
                );
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
                    take: 5001,
                });
                if (
                    documents.length > 5000 ||
                    documents.some(
                        (document) =>
                            !document.publishedIndexedDocument ||
                            document.publishedIndexedDocument.status !==
                                'PUBLISHED' ||
                            document.publishedIndexedDocument
                                .sourceVersionId !==
                                document.desiredVersionId ||
                            document.publishedIndexedDocument.extractionId !==
                                document.desiredExtractionId ||
                            document.publishedIndexedDocument
                                .metadataRevision !==
                                document.desiredMetadataRevision
                    )
                )
                    return;
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
                try {
                    await requireIndexAuthority(tx, principal);
                } catch (error) {
                    if (
                        !(error instanceof IndexingError) ||
                        error.code !== 'ACCESS_REVOKED'
                    )
                        throw error;
                    await tx.indexTask.update({
                        where: { id: principal.id },
                        data: {
                            status: 'FAILED',
                            stage: 'ACTIVATION',
                            errorCode: 'ACCESS_REVOKED',
                            completedAt: null,
                        },
                    });
                    await tx.indexGeneration.update({
                        where: { id: generation.id },
                        data: { lastErrorCode: 'ACCESS_REVOKED' },
                    });
                    return;
                }
                const active = documents.reduce(
                    (sum, document) =>
                        sum +
                        document.publishedIndexedDocument!.materializedChunks,
                    0
                );
                await tx.collectionIndexAccounting.update({
                    where: { collectionId: collection.id },
                    data: {
                        activeChunks: { increment: active },
                        retainedChunks: { decrement: active },
                        revision: { increment: 1 },
                    },
                });
                await tx.indexGeneration.update({
                    where: { id: generation.id },
                    data: {
                        status: 'ACTIVE',
                        activatedAt: new Date(),
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
                            chunks: active,
                        },
                    },
                });
            },
            { timeout: 30_000 }
        );
}

export { closeVectorAdapters } from './generation-adapter';
