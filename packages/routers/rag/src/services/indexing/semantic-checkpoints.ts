import type { Prisma } from '@repo/db';
import type { EmbeddingBatch, EmbeddingResult } from '@repo/embeddings';
import {
    SemanticStateError,
    quantizeSemanticVector,
    quantizedAdjacentDistance,
    validateSemanticDistances,
    type SemanticState,
} from '@repo/chunking';
import { IndexingError } from './task-state';
import { semanticQuotaLimits } from '../semantic-quotas';
import {
    encodeSemanticCheckpoint,
    decodeSemanticCheckpoint,
    semanticPayloadBytes,
    type SemanticPlanContext,
} from './semantic-plan-state';

/** Called only inside the usage-settlement transaction, after live claim/authority/candidate fences. */
export async function checkpointSemanticBatch(
    tx: Prisma.TransactionClient,
    input: {
        candidateId: string;
        organizationId: string;
        initialOffset: number;
        context: SemanticPlanContext;
        state: SemanticState;
        batch: EmbeddingBatch;
        result: EmbeddingResult;
    }
) {
    const plan = await tx.semanticChunkPlan.findUniqueOrThrow({
        where: { indexedDocumentId: input.candidateId },
    });
    const expected = input.initialOffset + input.batch.inputOffset;
    const distances = Array.isArray(plan.boundaryScores)
        ? [...plan.boundaryScores]
        : [];
    if (
        plan.organizationId !== input.organizationId ||
        plan.state !== 'PLANNING' ||
        plan.completedUnits !== expected ||
        expected + input.batch.inputCount > plan.unitCount ||
        input.result.vectors.length !== input.batch.inputCount ||
        plan.unitManifestHash !== input.state.unitManifestHash ||
        plan.sourceHash !== input.context.sourceHash ||
        plan.profileHash !== input.context.profileHash ||
        distances.some((value) => typeof value !== 'number')
    )
        throw new SemanticStateError();
    // JSON is narrowed through a scalar guard instead of trusting a persisted cast.
    const scores = distances.filter(
        (value): value is number => typeof value === 'number'
    );
    validateSemanticDistances(scores, expected);
    let last = expected
        ? decodeSemanticCheckpoint(
              plan.lastUnitVector,
              input.context.dimensions
          )
        : null;
    for (const vector of input.result.vectors) {
        if (vector.length !== input.context.dimensions)
            throw new SemanticStateError();
        const current = quantizeSemanticVector(vector);
        if (last) scores.push(quantizedAdjacentDistance(last, current));
        last = current;
    }
    if (!last) throw new SemanticStateError();
    const lastUnitVector = encodeSemanticCheckpoint(last);
    const storedBytes = BigInt(
        semanticPayloadBytes({
            ...plan,
            boundaryScores: scores,
            lastUnitVector,
        })
    );
    const limits = await semanticQuotaLimits(tx, input.organizationId);
    const growth = storedBytes - plan.storedBytes;
    if (
        storedBytes > BigInt(limits.semanticPlanBytesPerDocument) ||
        growth > plan.reservedBytes
    )
        throw new IndexingError('QUOTA_EXCEEDED');
    await tx.semanticChunkPlan.update({
        where: { indexedDocumentId: input.candidateId },
        data: {
            completedUnits: expected + input.batch.inputCount,
            boundaryScores: scores,
            lastUnitVector,
            storedBytes,
            reservedBytes: { decrement: growth },
            revision: { increment: 1 },
        },
    });
    await tx.organizationEmbeddingAccounting.update({
        where: { organizationId: input.organizationId },
        data: {
            storedPlanBytes: { increment: growth },
            reservedPlanBytes: { decrement: growth },
            revision: { increment: 1 },
        },
    });
}
