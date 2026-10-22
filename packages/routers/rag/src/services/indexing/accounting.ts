import type { Prisma } from '@repo/db';
import { quotaLimits } from '../quotas';
import { IndexingError } from './task-state';

/** Admission includes active, retained and reserved chunks; a rebuilding target separately fits the active limit. */
export async function reserveCandidateChunks(
    tx: Prisma.TransactionClient,
    input: {
        organizationId: string;
        collectionId: string;
        generationId: string;
        documentId: string;
        candidateId: string;
        taskId: string;
        count: number;
    }
) {
    const candidate = await tx.indexedDocument.findUniqueOrThrow({
        where: { id: input.candidateId },
    });
    if (candidate.chunkCount > 0) {
        if (candidate.chunkCount !== input.count)
            throw new IndexingError('PROCESSING_FAILED');
        return;
    }
    const [usage, generation, document, limits] = await Promise.all([
        tx.collectionIndexAccounting.upsert({
            where: { collectionId: input.collectionId },
            create: {
                organizationId: input.organizationId,
                collectionId: input.collectionId,
            },
            update: { revision: { increment: 1 } },
        }),
        tx.indexGeneration.findUniqueOrThrow({
            where: { id: input.generationId },
        }),
        tx.generationDocument.findUniqueOrThrow({
            where: {
                ['generationId_documentId']: {
                    generationId: input.generationId,
                    documentId: input.documentId,
                },
            },
        }),
        quotaLimits(tx, input.organizationId),
    ]);
    const projected =
        generation.projectedChunks -
        BigInt(document.targetChunkCount) +
        BigInt(input.count);
    if (
        projected > BigInt(limits.chunksPerCollection) ||
        usage.activeChunks +
            usage.retainedChunks +
            usage.reservedChunks +
            BigInt(input.count) >
            BigInt(
                limits.chunksPerCollection + limits.temporaryChunksPerCollection
            )
    )
        throw new IndexingError('QUOTA_EXCEEDED');
    await tx.collectionIndexAccounting.update({
        where: { collectionId: input.collectionId },
        data: {
            reservedChunks: { increment: input.count },
            revision: { increment: 1 },
        },
    });
    await tx.indexGeneration.update({
        where: { id: input.generationId },
        data: { projectedChunks: projected },
    });
    await tx.generationDocument.update({
        where: {
            ['generationId_documentId']: {
                generationId: input.generationId,
                documentId: input.documentId,
            },
        },
        data: { targetChunkCount: input.count },
    });
    await tx.indexedDocument.update({
        where: { id: input.candidateId },
        data: { chunkCount: input.count },
    });
    await tx.indexTask.update({
        where: { id: input.taskId },
        data: { reservedChunks: input.count },
    });
}

/** Move only acknowledged inserted rows from reservation to retained materialization. */
export async function accountMaterializedChunks(
    tx: Prisma.TransactionClient,
    input: {
        collectionId: string;
        candidateId: string;
        taskId: string;
        count: number;
    }
) {
    await tx.collectionIndexAccounting.update({
        where: { collectionId: input.collectionId },
        data: {
            reservedChunks: { decrement: input.count },
            retainedChunks: { increment: input.count },
            revision: { increment: 1 },
        },
    });
    await tx.indexedDocument.update({
        where: { id: input.candidateId },
        data: { materializedChunks: { increment: input.count } },
    });
    await tx.indexTask.update({
        where: { id: input.taskId },
        data: { reservedChunks: { decrement: input.count } },
    });
}

/** A physical purge releases retained rows and unfinished reservations in the same transaction as their metadata. */
export async function accountPurgedCandidate(
    tx: Prisma.TransactionClient,
    input: { collectionId: string; candidateId: string }
) {
    const candidate = await tx.indexedDocument.findUniqueOrThrow({
        where: { id: input.candidateId },
    });
    if (candidate.status === 'CLEANED') return;
    const tasks = await tx.indexTask.findMany({
        where: { indexedDocumentId: input.candidateId, kind: 'INDEX_DOCUMENT' },
        select: { id: true, reservedChunks: true },
    });
    const reserved = tasks.reduce(
        (total, task) => total + task.reservedChunks,
        0
    );
    await tx.collectionIndexAccounting.update({
        where: { collectionId: input.collectionId },
        data: {
            retainedChunks: { decrement: candidate.materializedChunks },
            reservedChunks: { decrement: reserved },
            revision: { increment: 1 },
        },
    });
    await tx.indexTask.updateMany({
        where: { indexedDocumentId: input.candidateId, kind: 'INDEX_DOCUMENT' },
        data: { reservedChunks: 0 },
    });
    await tx.chunk.deleteMany({
        where: { indexedDocumentId: input.candidateId },
    });
    await tx.indexedDocument.update({
        where: { id: input.candidateId },
        data: { status: 'CLEANED', materializedChunks: 0 },
    });
}
