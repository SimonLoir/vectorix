import type { IndexTask, PrismaClient } from '@repo/db';
import type { EmbeddingConfiguration, ModelIdentity } from '@repo/embeddings';
import { embedDocuments } from '@repo/embeddings';
import {
    chunkDocumentSemantic,
    semanticPlanHash,
    semanticThreshold,
    SemanticStateError,
    type PlannedChunk,
} from '@repo/chunking';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    admitSemanticPlan,
    continueSemanticTask,
    SemanticContinuation,
} from './semantic-capacity';
import {
    readSemanticPlan,
    semanticPayloadBytes,
    type SemanticPlanContext,
} from './semantic-plan-state';
import { checkpointSemanticBatch } from './semantic-checkpoints';
import {
    createSemanticWorkObserver,
    lockSemanticAccounting,
} from './semantic-work';
import { requireCurrentCandidate } from './publication-state';
import {
    renewIndexClaim,
    requireIndexAuthority,
    IndexingError,
    type IndexClaim,
} from './task-state';
import { semanticQuotaLimits } from '../semantic-quotas';
import { collectIndexChunks } from './planned-chunks';
import type { TelemetryExecution } from '../telemetry/types';
import { measureSyncTelemetry, measureTelemetry } from '../telemetry/domain';

/** Spend only a bounded prefix in one claim; every accepted native batch checkpoints before the next dispatch. */
export async function planSemanticCandidate(
    db: PrismaClient,
    input: {
        claim: IndexClaim;
        task: IndexTask;
        candidateId: string;
        context: SemanticPlanContext;
        credentials: EmbeddingConfiguration;
        identity: ModelIdentity;
        preparation: string;
        title: string;
        telemetry?: TelemetryExecution;
    }
): Promise<PlannedChunk[]> {
    const { claim, task, candidateId, context } = input;
    const admitted = await runSerializableTransaction(
        db,
        (tx) => admitSemanticPlan(tx, claim, task, candidateId, context),
        { timeout: 30_000 }
    );
    if (!admitted) {
        await runSerializableTransaction(db, (tx) =>
            continueSemanticTask(tx, claim, 'WAITING_FOR_EMBEDDING_CAPACITY')
        );
        throw new SemanticContinuation();
    }
    let plan = admitted;
    const state = readSemanticPlan(plan, context);
    if (plan.state === 'PLANNING' && plan.completedUnits < plan.unitCount) {
        const initialOffset = plan.completedUnits;
        const batchObserver = createSemanticWorkObserver(
            db,
            claim,
            task,
            candidateId,
            'BOUNDARY',
            `boundary:${initialOffset}`,
            async (tx, batch, result) => {
                await checkpointSemanticBatch(tx, {
                    candidateId,
                    organizationId: claim.organizationId,
                    initialOffset,
                    context,
                    state,
                    batch,
                    result,
                });
            }
        );
        await measureTelemetry(input.telemetry, 'BOUNDARY_EMBED', () =>
            embedDocuments(
                input.credentials,
                input.identity,
                state.units
                    .slice(initialOffset, initialOffset + 32)
                    .map((unit) => ({
                        text: context.artifact.text.slice(unit.start, unit.end),
                        title: input.title,
                    })),
                {
                    preparation: input.preparation,
                    timeoutMs: 90_000,
                    batchObserver,
                    numericObserver: input.telemetry?.nativeObserver,
                }
            )
        );
        plan = await db.semanticChunkPlan.findUniqueOrThrow({
            where: { indexedDocumentId: candidateId },
        });
    }
    const complete = readSemanticPlan(plan, context);
    if (plan.completedUnits !== plan.unitCount) {
        await runSerializableTransaction(db, (tx) =>
            continueSemanticTask(tx, claim, 'SEMANTIC_PLANNING')
        );
        throw new SemanticContinuation();
    }
    // Exhaust the pure planner outside the transaction. No partial chunk materialization is possible on a hard limit.
    const chunks = measureSyncTelemetry(input.telemetry, 'PLAN', () =>
        collectIndexChunks(
            chunkDocumentSemantic(context.artifact, context.options, complete)
        )
    );
    if (plan.state === 'READY') return chunks;
    const finalRanges = chunks.map(({ ordinal, start, end }) => ({
        ordinal,
        start,
        end,
    }));
    const planHash = semanticPlanHash(complete, context.options, finalRanges);
    const expectedRevision = plan.revision;
    await runSerializableTransaction(
        db,
        async (tx) => {
            await lockSemanticAccounting(tx, claim.organizationId);
            await renewIndexClaim(tx, claim, 'SEALING_SEMANTIC_PLAN');
            await requireIndexAuthority(tx, task);
            await requireCurrentCandidate(tx, claim, candidateId);
            const current = await tx.semanticChunkPlan.findUniqueOrThrow({
                where: { indexedDocumentId: candidateId },
            });
            if (
                current.state !== 'PLANNING' ||
                current.revision !== expectedRevision ||
                current.completedUnits !== current.unitCount
            )
                throw new SemanticStateError();
            const storedBytes = BigInt(
                semanticPayloadBytes({
                    ...current,
                    finalRanges,
                    planHash,
                    lastUnitVector: null,
                })
            );
            const growth = storedBytes - current.storedBytes;
            const limits = await semanticQuotaLimits(tx, claim.organizationId);
            if (
                growth > current.reservedBytes ||
                storedBytes > BigInt(limits.semanticPlanBytesPerDocument)
            )
                throw new IndexingError('QUOTA_EXCEEDED');
            await tx.semanticChunkPlan.update({
                where: { indexedDocumentId: candidateId },
                data: {
                    state: 'READY',
                    finalRanges,
                    planHash,
                    sealedAt: new Date(),
                    lastUnitVector: null,
                    thresholdDistance: semanticThreshold(
                        complete.distances,
                        context.options.semanticPercentile
                    ),
                    storedBytes,
                    reservedBytes: 0n,
                    revision: { increment: 1 },
                },
            });
            await tx.organizationEmbeddingAccounting.update({
                where: { organizationId: claim.organizationId },
                data: {
                    storedPlanBytes: { increment: growth },
                    reservedPlanBytes: { decrement: current.reservedBytes },
                    revision: { increment: 1 },
                },
            });
        },
        { timeout: 30_000 }
    );
    return chunks;
}
