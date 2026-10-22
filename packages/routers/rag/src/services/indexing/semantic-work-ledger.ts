import { randomUUID } from 'node:crypto';
import type {
    Prisma,
    PrismaClient,
    IndexTask,
    EmbeddingWorkPurpose,
    EmbeddingWorkAttempt,
} from '@repo/db';
import {
    modelIdentity,
    type EmbeddingBatch,
    type EmbeddingResult,
} from '@repo/embeddings';
import {
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
} from '@repo/chunking';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { semanticQuotaLimits } from '../semantic-quotas';
import { matchesEmbeddingIdentity } from './embedding-profile';
import {
    requireCurrentCandidate,
    CandidateObsolete,
} from './publication-state';
import {
    INDEX_LEASE_MS,
    IndexingError,
    IndexLeaseLost,
    renewIndexClaim,
    requireIndexAuthority,
    type IndexClaim,
} from './task-state';
import {
    isSemanticWorkDenial,
    semanticObservedUsage,
    validateSemanticBatch,
} from './semantic-work-validation';

export const MAX_SEMANTIC_WORK_ATTEMPTS = 4096;

/** Serialize all semantic storage/work counters through one organization accounting row. */
export async function lockSemanticAccounting(
    tx: Prisma.TransactionClient,
    organizationId: string
) {
    return await tx.organizationEmbeddingAccounting.upsert({
        where: { organizationId },
        create: { organizationId },
        update: { revision: { increment: 1 } },
    });
}

export interface SemanticWorkContext {
    db: PrismaClient;
    claim: IndexClaim;
    task: IndexTask;
    candidateId: string;
    purpose: EmbeddingWorkPurpose;
    operationKey: string;
}

/** Task provenance is checked in the database; a caller-supplied task snapshot cannot bind another candidate. */
async function requireWorkClaim(
    tx: Prisma.TransactionClient,
    context: SemanticWorkContext
) {
    const task = await tx.indexTask.findFirst({
        where: {
            id: context.claim.id,
            organizationId: context.claim.organizationId,
            collectionId: context.claim.collectionId,
            generationId: context.claim.generationId,
            indexedDocumentId: context.candidateId,
            kind: 'INDEX_DOCUMENT',
            status: 'PROCESSING',
            leaseToken: context.claim.token,
            leaseEpoch: context.claim.leaseEpoch,
            leasedUntil: { gt: new Date() },
            requestedBy: context.task.requestedBy,
        },
    });
    if (!task) throw new IndexLeaseLost();
    return task;
}

/** Reserve and record one dispatch intent before I/O; a retry consumes another lifetime attempt. */
export async function dispatchSemanticWork(
    context: SemanticWorkContext,
    batch: EmbeddingBatch
) {
    validateSemanticBatch(batch);
    if (!/^[A-Za-z\d:._/-]{1,128}$/u.test(context.operationKey))
        throw new IndexingError('PROCESSING_FAILED');
    return await runSerializableTransaction(context.db, async (tx) => {
        await lockSemanticAccounting(tx, context.claim.organizationId);
        const currentTask = await requireWorkClaim(tx, context);
        await renewIndexClaim(
            tx,
            context.claim,
            context.purpose === 'BOUNDARY' ? 'SEMANTIC_PLANNING' : 'EMBEDDING'
        );
        await requireIndexAuthority(tx, currentTask);
        const { generation } = await requireCurrentCandidate(
            tx,
            context.claim,
            context.candidateId
        );
        const plan = await tx.semanticChunkPlan.findUnique({
            where: { indexedDocumentId: context.candidateId },
        });
        const profile = await tx.collectionConfigRevision.findUniqueOrThrow({
            where: {
                ['organizationId_collectionId_revision']: {
                    organizationId: context.claim.organizationId,
                    collectionId: context.claim.collectionId,
                    revision: generation.configurationRevision,
                },
            },
        });
        const identity = modelIdentity.safeParse(generation.capabilitySnapshot);
        if (
            !plan ||
            plan.organizationId !== context.claim.organizationId ||
            plan.generationId !== context.claim.generationId ||
            plan.state !==
                (context.purpose === 'BOUNDARY' ? 'PLANNING' : 'READY') ||
            generation.chunkerVersion !== SEMANTIC_CHUNKER_VERSION ||
            profile.chunkingStrategy !== 'SEMANTIC' ||
            profile.parentChild ||
            plan.configurationRevision !== generation.configurationRevision ||
            plan.chunkerVersion !== generation.chunkerVersion ||
            plan.unitizerVersion !== SEMANTIC_UNITIZER_VERSION ||
            plan.modelIdentity !== generation.modelIdentity ||
            !identity.success ||
            !matchesEmbeddingIdentity(
                identity.data,
                profile,
                generation.modelIdentity
            ) ||
            batch.provider !== identity.data.provider ||
            batch.model !== identity.data.model ||
            batch.modelIdentity !== generation.modelIdentity
        )
            throw new IndexingError('MODEL_CHANGED');
        const [limits, lifetime, previous, liveTask] = await Promise.all([
            semanticQuotaLimits(tx, context.claim.organizationId),
            tx.embeddingWorkAttempt.aggregate({
                where: {
                    organizationId: context.claim.organizationId,
                    indexedDocumentId: context.candidateId,
                },
                _count: { id: true },
                _sum: {
                    dispatchedPreparedBytes: true,
                    dispatchedBatches: true,
                },
            }),
            tx.embeddingWorkAttempt.aggregate({
                where: {
                    organizationId: context.claim.organizationId,
                    indexedDocumentId: context.candidateId,
                    purpose: context.purpose,
                    operationKey: context.operationKey,
                    batchOrdinal: batch.ordinal,
                },
                _max: { attemptNumber: true },
            }),
            tx.indexTask.findUniqueOrThrow({
                where: { id: context.claim.id },
                select: { leasedUntil: true },
            }),
        ]);
        if (
            lifetime._count.id >=
                Math.min(
                    MAX_SEMANTIC_WORK_ATTEMPTS,
                    limits.embeddingBatchesPerCandidate
                ) ||
            (lifetime._sum.dispatchedPreparedBytes ?? 0n) +
                BigInt(batch.preparedInputBytes) >
                BigInt(limits.embeddingPreparedBytesPerCandidate) ||
            (lifetime._sum.dispatchedBatches ?? 0) + 1 >
                limits.embeddingBatchesPerCandidate
        )
            throw new IndexingError('QUOTA_EXCEEDED');
        if (
            plan.reservedPreparedBytes < BigInt(batch.preparedInputBytes) ||
            plan.reservedBatches < 1
        )
            throw new IndexingError('QUOTA_EXCEEDED');
        const now = new Date();
        if (!liveTask.leasedUntil || liveTask.leasedUntil <= now)
            throw new IndexLeaseLost();
        const work = await tx.embeddingWorkAttempt.create({
            data: {
                id: randomUUID(),
                organizationId: context.claim.organizationId,
                generationId: context.claim.generationId,
                indexedDocumentId: context.candidateId,
                purpose: context.purpose,
                operationKey: context.operationKey,
                batchOrdinal: batch.ordinal,
                attemptNumber: (previous._max.attemptNumber ?? 0) + 1,
                inputHash: batch.preparedInputHash,
                inputCount: batch.inputCount,
                preparedInputBytes: batch.preparedInputBytes,
                taskId: context.claim.id,
                leaseEpoch: context.claim.leaseEpoch,
                state: 'IN_FLIGHT',
                reservedPreparedBytes: BigInt(batch.preparedInputBytes),
                reservedBatches: 1,
                dispatchedPreparedBytes: BigInt(batch.preparedInputBytes),
                dispatchedBatches: 1,
                dispatchStartedAt: now,
                deadlineAt: new Date(
                    Math.min(
                        liveTask.leasedUntil.getTime(),
                        now.getTime() + INDEX_LEASE_MS
                    )
                ),
            },
        });
        await tx.semanticChunkPlan.update({
            where: { indexedDocumentId: context.candidateId },
            data: {
                reservedPreparedBytes: { decrement: batch.preparedInputBytes },
                reservedBatches: { decrement: 1 },
                revision: { increment: 1 },
            },
        });
        await tx.organizationEmbeddingAccounting.update({
            where: { organizationId: context.claim.organizationId },
            data: {
                dispatchedPreparedBytes: {
                    increment: batch.preparedInputBytes,
                },
                dispatchedBatches: { increment: 1 },
                revision: { increment: 1 },
            },
        });
        return work.id;
    });
}

/** Record selected evidence once, releasing outstanding capacity in the same transaction. */
async function recordKnownSuccess(
    tx: Prisma.TransactionClient,
    work: EmbeddingWorkAttempt,
    usage: ReturnType<typeof semanticObservedUsage>
) {
    let newlyObserved = false;
    if (work.usageRecordedAt === null) {
        if (
            !['IN_FLIGHT', 'UNCERTAIN'].includes(work.state) ||
            work.dispatchedBatches !== 1
        )
            throw new IndexingError('PROCESSING_FAILED');
        const observed = await tx.embeddingWorkAttempt.updateMany({
            where: {
                id: work.id,
                usageRecordedAt: null,
                state: { in: ['IN_FLIGHT', 'UNCERTAIN'] },
            },
            data: {
                ...usage,
                state: 'SUCCEEDED',
                reservedPreparedBytes: 0,
                reservedBatches: 0,
                usageRecordedAt: new Date(),
                settledAt: new Date(),
                outcomeCode: null,
            },
        });
        newlyObserved = observed.count > 0;
        if (newlyObserved)
            await tx.organizationEmbeddingAccounting.update({
                where: { organizationId: work.organizationId },
                data: {
                    reservedPreparedBytes: {
                        decrement: work.reservedPreparedBytes,
                    },
                    reservedBatches: { decrement: work.reservedBatches },
                    uncertainAttempts: {
                        decrement: work.state === 'UNCERTAIN' ? 1 : 0,
                    },
                    observedSuccessfulRequests: { increment: 1 },
                    observedEstimatedInputTokens: {
                        increment: usage.estimatedInputTokens,
                    },
                    observedProviderInputTokens: {
                        increment: usage.providerInputTokens ?? 0n,
                    },
                    observedBilledInputTokens: {
                        increment: usage.billedInputTokens ?? 0,
                    },
                    unknownProviderTokenBatches: {
                        increment: usage.providerInputTokens === null ? 1 : 0,
                    },
                    unknownBilledTokenBatches: {
                        increment: usage.billedInputTokens === null ? 1 : 0,
                    },
                    revision: { increment: 1 },
                },
            });
    }
    return newlyObserved;
}

/**
 * Commit validated usage even for stale/removed actors. The optional checkpoint must
 * validate all domain state before writing and perform database I/O only. Known domain
 * denials are thrown after commit; Prisma/driver errors abort the complete transaction.
 */
export async function settleSemanticWork(
    context: SemanticWorkContext,
    workId: string,
    batch: EmbeddingBatch,
    result: EmbeddingResult,
    onValidated?: (
        tx: Prisma.TransactionClient,
        batch: EmbeddingBatch,
        result: EmbeddingResult
    ) => Promise<void>
) {
    const usage = semanticObservedUsage(batch, result);
    const denial = await runSerializableTransaction(context.db, async (tx) => {
        const initial = await tx.embeddingWorkAttempt.findFirst({
            where: {
                id: workId,
                organizationId: context.claim.organizationId,
                indexedDocumentId: context.candidateId,
                taskId: context.claim.id,
                leaseEpoch: context.claim.leaseEpoch,
            },
        });
        if (!initial) return new CandidateObsolete();
        await lockSemanticAccounting(tx, context.claim.organizationId);
        const work = await tx.embeddingWorkAttempt.findUniqueOrThrow({
            where: { id: workId },
        });
        const newlyObserved = await recordKnownSuccess(tx, work, usage);
        try {
            if (work.deadlineAt <= new Date()) throw new IndexLeaseLost();
            const currentTask = await requireWorkClaim(tx, context);
            await requireIndexAuthority(tx, currentTask);
            await requireCurrentCandidate(
                tx,
                context.claim,
                context.candidateId
            );
            await renewIndexClaim(tx, context.claim);
            if (newlyObserved && onValidated)
                await onValidated(tx, batch, result);
            return null;
        } catch (error) {
            if (isSemanticWorkDenial(error)) return error;
            throw error;
        }
    });
    if (denial) throw denial;
}
