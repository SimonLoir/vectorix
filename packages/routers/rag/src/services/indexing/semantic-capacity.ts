import type { Prisma, SemanticChunkPlan, IndexTask } from '@repo/db';
import {
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
    semanticUnitManifestHash,
    unitizeSemantic,
} from '@repo/chunking';
import { semanticQuotaLimits } from '../semantic-quotas';
import { requireCurrentCandidate } from './publication-state';
import {
    renewIndexClaim,
    requireIndexAuthority,
    IndexingError,
    type IndexClaim,
} from './task-state';
import { lockSemanticAccounting } from './semantic-work';
import {
    semanticPayloadBytes,
    readSemanticPlan,
    type SemanticPlanContext,
} from './semantic-plan-state';

/** A successful planning/capacity yield is distinct from failure retry control flow. */
export class SemanticContinuation extends Error {}

/** Reuse admitted capacity across policy increases; released candidates can request a new remaining allowance. */
function continuingAllowance(
    existing: SemanticChunkPlan | null,
    preparedBytes: bigint,
    batches: number,
    planningBytes: bigint
) {
    if (!existing)
        return {
            reservedPreparedBytes: preparedBytes,
            reservedBatches: batches,
            reservedBytes: planningBytes,
        };
    const active =
        existing.reservedPreparedBytes > 0n || existing.reservedBatches > 0;
    const smaller = (left: bigint, right: bigint) =>
        left < right ? left : right;
    return {
        reservedPreparedBytes: active
            ? smaller(existing.reservedPreparedBytes, preparedBytes)
            : preparedBytes,
        reservedBatches: active
            ? Math.min(existing.reservedBatches, batches)
            : batches,
        reservedBytes:
            existing.state === 'READY'
                ? 0n
                : active
                  ? smaller(existing.reservedBytes, planningBytes)
                  : planningBytes,
    };
}

/** Reserve a complete bounded candidate allowance, or atomically defer without partial capacity. */
export async function admitSemanticPlan(
    tx: Prisma.TransactionClient,
    claim: IndexClaim,
    task: IndexTask,
    candidateId: string,
    context: SemanticPlanContext
): Promise<SemanticChunkPlan | null> {
    const usage = await lockSemanticAccounting(tx, claim.organizationId);
    await renewIndexClaim(tx, claim, 'SEMANTIC_PLANNING');
    await requireIndexAuthority(tx, task);
    await requireCurrentCandidate(tx, claim, candidateId);
    const limits = await semanticQuotaLimits(tx, claim.organizationId);
    const existing = await tx.semanticChunkPlan.findUnique({
        where: { indexedDocumentId: candidateId },
    });
    const units = existing
        ? readSemanticPlan(existing, context).units
        : unitizeSemantic(context.artifact, {
              ...context.options,
              maxUnits: limits.semanticUnitsPerDocument,
          });
    if (!units.length) throw new IndexingError('SOURCE_UNAVAILABLE');
    if (units.length > limits.semanticUnitsPerDocument)
        throw new IndexingError('CHUNK_LIMIT');
    const initial = {
        indexedDocumentId: candidateId,
        organizationId: claim.organizationId,
        generationId: claim.generationId,
        configurationRevision: context.configurationRevision,
        chunkerVersion: SEMANTIC_CHUNKER_VERSION,
        unitizerVersion: SEMANTIC_UNITIZER_VERSION,
        sourceHash: context.sourceHash,
        profileHash: context.profileHash,
        modelIdentity: context.modelIdentity,
        unitManifestHash: semanticUnitManifestHash(
            context.artifact,
            units,
            context.options
        ),
        unitCount: units.length,
        unitRanges: units.map(({ ordinal, start, end }) => ({
            ordinal,
            start,
            end,
        })),
        boundaryScores: [],
        finalRanges: null,
        lastUnitVector: null,
        planHash: null,
    };
    const storedBytes =
        existing?.storedBytes ?? BigInt(semanticPayloadBytes(initial));
    if (storedBytes > BigInt(limits.semanticPlanBytesPerDocument))
        throw new IndexingError('QUOTA_EXCEEDED');
    const dispatched = await tx.embeddingWorkAttempt.aggregate({
        where: {
            organizationId: claim.organizationId,
            indexedDocumentId: candidateId,
        },
        _sum: { dispatchedPreparedBytes: true, dispatchedBatches: true },
    });
    const remainingPreparedBytes =
        BigInt(limits.embeddingPreparedBytesPerCandidate) -
        (dispatched._sum.dispatchedPreparedBytes ?? 0n);
    const remainingBatches =
        limits.embeddingBatchesPerCandidate -
        (dispatched._sum.dispatchedBatches ?? 0);
    if (remainingPreparedBytes < 0n || remainingBatches < 0)
        throw new IndexingError('QUOTA_EXCEEDED');
    // A policy increase must not make every existing holder wait for a larger
    // reservation while retaining the old one. Finish with admitted capacity;
    // a new admission or authorized retry after release may use the larger cap.
    const planningCapacity =
        BigInt(limits.semanticPlanBytesPerDocument) - storedBytes;
    const { reservedPreparedBytes, reservedBatches, reservedBytes } =
        continuingAllowance(
            existing,
            remainingPreparedBytes,
            remainingBatches,
            planningCapacity
        );
    const planDelta =
        reservedBytes +
        storedBytes -
        (existing?.reservedBytes ?? 0n) -
        (existing?.storedBytes ?? 0n);
    const workDelta =
        reservedPreparedBytes - (existing?.reservedPreparedBytes ?? 0n);
    const batchDelta = BigInt(
        reservedBatches - (existing?.reservedBatches ?? 0)
    );
    if (
        (planDelta > 0n &&
            usage.storedPlanBytes + usage.reservedPlanBytes + planDelta >
                BigInt(limits.semanticPlanBytesPerOrganization)) ||
        (workDelta > 0n &&
            usage.reservedPreparedBytes + workDelta >
                BigInt(limits.embeddingOutstandingPreparedBytes)) ||
        (batchDelta > 0n &&
            usage.reservedBatches + batchDelta >
                BigInt(limits.embeddingOutstandingBatches))
    )
        return null;
    const plan = existing
        ? await tx.semanticChunkPlan.update({
              where: { indexedDocumentId: candidateId },
              data: {
                  reservedBytes,
                  reservedPreparedBytes,
                  reservedBatches,
                  revision: { increment: 1 },
              },
          })
        : await tx.semanticChunkPlan.create({
              data: {
                  ...initial,
                  finalRanges: undefined,
                  storedBytes,
                  reservedBytes,
                  reservedPreparedBytes,
                  reservedBatches,
              },
          });
    await tx.organizationEmbeddingAccounting.update({
        where: { organizationId: claim.organizationId },
        data: {
            storedPlanBytes: { increment: existing ? 0n : storedBytes },
            reservedPlanBytes: {
                increment: reservedBytes - (existing?.reservedBytes ?? 0n),
            },
            reservedPreparedBytes: { increment: workDelta },
            reservedBatches: { increment: batchDelta },
            revision: { increment: 1 },
        },
    });
    return plan;
}

/** Lease-fenced successful continuation; the next claim does not consume another failure attempt. */
export async function continueSemanticTask(
    tx: Prisma.TransactionClient,
    claim: IndexClaim,
    stage: 'SEMANTIC_PLANNING' | 'WAITING_FOR_EMBEDDING_CAPACITY'
) {
    await renewIndexClaim(tx, claim, stage);
    await tx.indexTask.update({
        where: { id: claim.id },
        data: {
            status: 'PENDING',
            stage,
            continuationPending: true,
            continuations: { increment: 1 },
            leaseToken: null,
            leasedUntil: null,
            errorCode: null,
            availableAt: new Date(
                Date.now() +
                    (stage === 'WAITING_FOR_EMBEDDING_CAPACITY' ? 5000 : 100)
            ),
        },
    });
}
