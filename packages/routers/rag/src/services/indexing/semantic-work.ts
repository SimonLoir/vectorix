import type {
    IndexTask,
    Prisma,
    PrismaClient,
    EmbeddingWorkPurpose,
} from '@repo/db';
import type {
    EmbeddingBatch,
    EmbeddingBatchObserver,
    EmbeddingResult,
} from '@repo/embeddings';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { IndexingError, type IndexClaim } from './task-state';
import {
    dispatchSemanticWork,
    settleSemanticWork,
    type SemanticWorkContext,
} from './semantic-work-ledger';
import { failSemanticWork } from './semantic-work-lifecycle';
import { sameSemanticBatch } from './semantic-work-validation';

export {
    lockSemanticAccounting,
    MAX_SEMANTIC_WORK_ATTEMPTS,
} from './semantic-work-ledger';
export {
    failSemanticWork,
    reapSemanticWork,
    releaseSemanticWorkAllowance,
    purgeSemanticPlan,
} from './semantic-work-lifecycle';

/**
 * Create one observer per embed call. The caller owns a stable phase/offset operation
 * key; ordinals restart per call and each redispatch consumes a new lifetime attempt.
 * Checkpoints are database-only and must throw domain denials before any writes.
 */
export function createSemanticWorkObserver(
    db: PrismaClient,
    claim: IndexClaim,
    task: IndexTask,
    candidateId: string,
    purpose: EmbeddingWorkPurpose,
    operationKey: string,
    onValidated?: (
        tx: Prisma.TransactionClient,
        batch: EmbeddingBatch,
        result: EmbeddingResult
    ) => Promise<void>
): EmbeddingBatchObserver {
    if (
        task.id !== claim.id ||
        task.organizationId !== claim.organizationId ||
        task.collectionId !== claim.collectionId ||
        task.generationId !== claim.generationId ||
        task.indexedDocumentId !== candidateId ||
        !['BOUNDARY', 'FINAL_DOCUMENT'].includes(purpose)
    )
        throw new IndexingError('PROCESSING_FAILED');
    const context: SemanticWorkContext = {
        db,
        claim,
        task,
        candidateId,
        purpose,
        operationKey,
    };
    const admitted = new Map<number, { id: string; batch: EmbeddingBatch }>();
    const binding = (batch: EmbeddingBatch) => {
        const found = admitted.get(batch.ordinal);
        if (!found || !sameSemanticBatch(found.batch, batch))
            throw new IndexingError('PROCESSING_FAILED');
        return found;
    };
    return {
        async beforeBatch(batch) {
            if (admitted.has(batch.ordinal))
                throw new IndexingError('PROCESSING_FAILED');
            const id = await dispatchSemanticWork(context, batch);
            admitted.set(batch.ordinal, { id, batch: { ...batch } });
        },
        async afterBatch(batch, result) {
            await settleSemanticWork(
                context,
                binding(batch).id,
                batch,
                result,
                onValidated
            );
        },
        async failedBatch(batch, code) {
            const { id } = binding(batch);
            await runSerializableTransaction(db, (tx) =>
                failSemanticWork(tx, id, claim.organizationId, code)
            );
        },
    };
}
