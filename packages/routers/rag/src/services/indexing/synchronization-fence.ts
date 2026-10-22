import type { Prisma } from '@repo/db';
import { indexError } from './errors';
import { MAX_INDEXED_DOCUMENTS_PER_COLLECTION } from './limits';
import type { SynchronizationGeneration } from './sync-authority';

/**
 * The authorized caller holds the collection mutation fence. Rebind every live
 * cost-task epoch, including self-adoption, without replaying failed history or
 * releasing admitted work. Current tasks are bounded by the live document limit
 * plus one provision task; inconsistent/obsolete runnable state fails closed.
 */
export async function fenceSynchronizationTasks(
    tx: Prisma.TransactionClient,
    generation: SynchronizationGeneration,
    userId: string
) {
    // Serialize with existing semantic dispatch/settlement before task writes.
    // Do not create tracking/accounting for a generation with no semantic work.
    await tx.organizationEmbeddingAccounting.updateMany({
        where: { organizationId: generation.organizationId },
        data: { revision: { increment: 1 } },
    });
    const scope = {
        organizationId: generation.organizationId,
        collectionId: generation.collectionId,
        generationId: generation.id,
    };
    const [desired, tasks] = await Promise.all([
        tx.generationDocument.findMany({
            where: {
                ...scope,
                removedAt: null,
                desiredVersionId: { not: null },
            },
            select: {
                documentId: true,
                desiredVersionId: true,
                desiredExtractionId: true,
                desiredMetadataRevision: true,
                desiredChangeSequence: true,
                buildRevision: true,
            },
            take: MAX_INDEXED_DOCUMENTS_PER_COLLECTION + 1,
        }),
        tx.indexTask.findMany({
            where: {
                ...scope,
                kind: { in: ['PROVISION', 'INDEX_DOCUMENT'] },
                status: { in: ['PENDING', 'PROCESSING'] },
            },
            select: {
                id: true,
                kind: true,
                status: true,
                indexedDocument: {
                    select: {
                        documentId: true,
                        status: true,
                        sourceVersionId: true,
                        extractionId: true,
                        metadataRevision: true,
                        sourceChangeSequence: true,
                        buildRevision: true,
                    },
                },
            },
            take: MAX_INDEXED_DOCUMENTS_PER_COLLECTION + 2,
        }),
    ]);
    if (
        desired.length > MAX_INDEXED_DOCUMENTS_PER_COLLECTION ||
        tasks.length > MAX_INDEXED_DOCUMENTS_PER_COLLECTION + 1
    )
        throw indexError('GENERATION_CONFLICT');
    const current = new Map(desired.map((item) => [item.documentId, item]));
    let provisions = 0;
    for (const task of tasks) {
        if (task.kind === 'PROVISION') {
            provisions++;
            if (provisions > 1 || generation.status === 'ACTIVE')
                throw indexError('GENERATION_CONFLICT');
            continue;
        }
        const candidate = task.indexedDocument;
        const source = candidate ? current.get(candidate.documentId) : null;
        if (
            !candidate ||
            !source ||
            !['STAGING', 'SEALED', 'PUBLISHED'].includes(candidate.status) ||
            candidate.sourceVersionId !== source.desiredVersionId ||
            candidate.extractionId !== source.desiredExtractionId ||
            candidate.metadataRevision !== source.desiredMetadataRevision ||
            candidate.sourceChangeSequence !== source.desiredChangeSequence ||
            candidate.buildRevision !== source.buildRevision
        )
            throw indexError('GENERATION_CONFLICT');
    }
    if (tasks.length) {
        const updated = await tx.indexTask.updateMany({
            where: {
                ...scope,
                id: { in: tasks.map((task) => task.id) },
                kind: { in: ['PROVISION', 'INDEX_DOCUMENT'] },
                status: { in: ['PENDING', 'PROCESSING'] },
            },
            data: {
                requestedBy: userId,
                status: 'PENDING',
                availableAt: new Date(),
                leaseEpoch: { increment: 1 },
                leaseToken: null,
                leasedUntil: null,
            },
        });
        if (updated.count !== tasks.length)
            throw indexError('GENERATION_CONFLICT');
    }
    return {
        reboundPendingTasks: tasks.filter((task) => task.status === 'PENDING')
            .length,
        interruptedTasks: tasks.filter((task) => task.status === 'PROCESSING')
            .length,
    };
}

/** Caller has current session grants and the collection fence; CAS and task fences commit together. */
export async function transferSynchronizationController(
    tx: Prisma.TransactionClient,
    generation: SynchronizationGeneration,
    userId: string
) {
    const counts = await fenceSynchronizationTasks(tx, generation, userId);
    const changed = await tx.indexGeneration.updateMany({
        where: {
            id: generation.id,
            organizationId: generation.organizationId,
            collectionId: generation.collectionId,
            authorityUserId: generation.authorityUserId,
            status: generation.status,
        },
        data: { authorityUserId: userId },
    });
    if (!changed.count) throw indexError('GENERATION_CONFLICT');
    return counts;
}
