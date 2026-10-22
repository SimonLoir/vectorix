import { Prisma, type PrismaClient } from '@repo/db';
import type { EmbeddingErrorCode } from '@repo/embeddings';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { CandidateObsolete } from './publication-state';
import { IndexingError } from './task-state';
import { lockSemanticAccounting } from './semantic-work-ledger';

/** A missing validated response is uncertainty, not evidence that native work was free. */
export async function failSemanticWork(
    tx: Prisma.TransactionClient,
    workId: string,
    organizationId: string,
    code: EmbeddingErrorCode | 'RESERVATION_EXPIRED' = 'PROVIDER_TIMEOUT',
    expiredOnly = false
) {
    const initial = await tx.embeddingWorkAttempt.findFirst({
        where: { id: workId, organizationId },
    });
    if (!initial) return;
    await lockSemanticAccounting(tx, organizationId);
    const work = await tx.embeddingWorkAttempt.findUniqueOrThrow({
        where: { id: workId },
    });
    if (
        work.usageRecordedAt ||
        !['RESERVED', 'IN_FLIGHT'].includes(work.state) ||
        (expiredOnly && work.deadlineAt > new Date())
    )
        return;
    const uncertain = work.dispatchedBatches > 0;
    const settled = await tx.embeddingWorkAttempt.updateMany({
        where: {
            id: work.id,
            usageRecordedAt: null,
            state: { in: ['RESERVED', 'IN_FLIGHT'] },
            ...(expiredOnly ? { deadlineAt: { lte: new Date() } } : {}),
        },
        data: {
            state: uncertain ? 'UNCERTAIN' : 'CANCELLED',
            outcomeCode: uncertain ? code : 'RESERVATION_EXPIRED',
            reservedPreparedBytes: 0,
            reservedBatches: 0,
            settledAt: new Date(),
            ...(uncertain
                ? { uncertainAt: work.uncertainAt ?? new Date() }
                : {}),
        },
    });
    if (!settled.count) return;
    await tx.organizationEmbeddingAccounting.update({
        where: { organizationId },
        data: {
            reservedPreparedBytes: { decrement: work.reservedPreparedBytes },
            reservedBatches: { decrement: work.reservedBatches },
            uncertainAttempts: { increment: uncertain ? 1 : 0 },
            revision: { increment: 1 },
        },
    });
}

/** Bounded deadline settlement survives member removal and never overwrites validated usage. */
export async function reapSemanticWork(db: PrismaClient) {
    const expired = await db.embeddingWorkAttempt.findMany({
        where: {
            state: { in: ['RESERVED', 'IN_FLIGHT'] },
            deadlineAt: { lte: new Date() },
        },
        orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
        take: 100,
        select: { id: true, organizationId: true },
    });
    for (const work of expired)
        await runSerializableTransaction(db, (tx) =>
            failSemanticWork(
                tx,
                work.id,
                work.organizationId,
                'PROVIDER_TIMEOUT',
                true
            )
        );
}

/** Release unused planning/work allowance; stored payload, dispatch history and in-flight reservations remain intact. */
export async function releaseSemanticWorkAllowance(
    tx: Prisma.TransactionClient,
    candidateId: string
) {
    const initial = await tx.semanticChunkPlan.findUnique({
        where: { indexedDocumentId: candidateId },
    });
    if (!initial) return;
    await lockSemanticAccounting(tx, initial.organizationId);
    const plan = await tx.semanticChunkPlan.findUniqueOrThrow({
        where: { indexedDocumentId: candidateId },
    });
    if (
        plan.reservedBytes === 0n &&
        plan.reservedPreparedBytes === 0n &&
        plan.reservedBatches === 0
    )
        return;
    await tx.semanticChunkPlan.update({
        where: { indexedDocumentId: candidateId },
        data: {
            reservedBytes: 0,
            reservedPreparedBytes: 0,
            reservedBatches: 0,
            revision: { increment: 1 },
        },
    });
    await tx.organizationEmbeddingAccounting.update({
        where: { organizationId: plan.organizationId },
        data: {
            reservedPlanBytes: { decrement: plan.reservedBytes },
            reservedPreparedBytes: { decrement: plan.reservedPreparedBytes },
            reservedBatches: { decrement: plan.reservedBatches },
            revision: { increment: 1 },
        },
    });
}

/** After vector purge, clear charged content only once all in-flight work is settled/expired. False means defer cleanup. */
export async function purgeSemanticPlan(
    tx: Prisma.TransactionClient,
    candidateId: string
): Promise<boolean> {
    const initial = await tx.semanticChunkPlan.findUnique({
        where: { indexedDocumentId: candidateId },
    });
    if (!initial) return true;
    await releaseSemanticWorkAllowance(tx, candidateId);
    const plan = await tx.semanticChunkPlan.findUniqueOrThrow({
        where: { indexedDocumentId: candidateId },
    });
    const candidate = await tx.indexedDocument.findUniqueOrThrow({
        where: { id: candidateId },
        select: { status: true },
    });
    if (!['CLEANING', 'CLEANED'].includes(candidate.status))
        throw new CandidateObsolete();
    if (
        await tx.embeddingWorkAttempt.count({
            where: {
                indexedDocumentId: candidateId,
                OR: [
                    { state: { in: ['RESERVED', 'IN_FLIGHT'] } },
                    { reservedPreparedBytes: { gt: 0 } },
                    { reservedBatches: { gt: 0 } },
                ],
            },
        })
    )
        return false;
    if (plan.state === 'CLEANED') {
        if (
            plan.storedBytes !== 0n ||
            plan.reservedBytes !== 0n ||
            plan.reservedPreparedBytes !== 0n ||
            plan.reservedBatches !== 0
        )
            throw new IndexingError('PROCESSING_FAILED');
        return true;
    }
    await tx.semanticChunkPlan.update({
        where: { indexedDocumentId: candidateId },
        data: {
            state: 'CLEANED',
            unitRanges: [],
            boundaryScores: [],
            lastUnitVector: null,
            finalRanges: Prisma.DbNull,
            completedUnits: 0,
            thresholdDistance: null,
            storedBytes: 0,
            reservedBytes: 0,
            cleanedAt: new Date(),
            revision: { increment: 1 },
        },
    });
    await tx.organizationEmbeddingAccounting.update({
        where: { organizationId: plan.organizationId },
        data: {
            reservedPlanBytes: { decrement: plan.reservedBytes },
            storedPlanBytes: { decrement: plan.storedBytes },
            revision: { increment: 1 },
        },
    });
    return true;
}
