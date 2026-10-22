import type { EmbeddingBatch, EmbeddingResult } from '@repo/embeddings';
import { SemanticStateError } from '@repo/chunking';
import { CandidateObsolete } from './publication-state';
import { IndexingError, IndexLeaseLost } from './task-state';

/** Native-batch descriptors never contain text or credentials; reject malformed internal evidence. */
export function validateSemanticBatch(batch: EmbeddingBatch) {
    if (
        batch.kind !== 'document' ||
        !Number.isSafeInteger(batch.ordinal) ||
        batch.ordinal < 0 ||
        batch.ordinal >= 4096 ||
        !Number.isSafeInteger(batch.inputOffset) ||
        batch.inputOffset < 0 ||
        !Number.isSafeInteger(batch.inputCount) ||
        batch.inputCount < 1 ||
        batch.inputOffset + batch.inputCount > 4096 ||
        !Number.isSafeInteger(batch.preparedInputBytes) ||
        batch.preparedInputBytes < 1 ||
        batch.preparedInputBytes > 2 * 1024 ** 2 ||
        !Number.isSafeInteger(batch.estimatedInputTokens) ||
        batch.estimatedInputTokens < Math.ceil(batch.preparedInputBytes / 4) ||
        batch.estimatedInputTokens >
            Math.ceil(batch.preparedInputBytes / 4) + batch.inputCount - 1 ||
        batch.preparedInputHashVersion !== 'sha256-json-strings-v1' ||
        !/^[a-f\d]{64}$/u.test(batch.preparedInputHash)
    )
        throw new IndexingError('PROCESSING_FAILED');
}

/** A callback can settle only the exact descriptor admitted by this observer instance. */
export function sameSemanticBatch(left: EmbeddingBatch, right: EmbeddingBatch) {
    return (
        left.provider === right.provider &&
        left.model === right.model &&
        left.modelIdentity === right.modelIdentity &&
        left.kind === right.kind &&
        left.ordinal === right.ordinal &&
        left.inputOffset === right.inputOffset &&
        left.inputCount === right.inputCount &&
        left.preparedInputBytes === right.preparedInputBytes &&
        left.estimatedInputTokens === right.estimatedInputTokens &&
        left.preparedInputHashVersion === right.preparedInputHashVersion &&
        left.preparedInputHash === right.preparedInputHash
    );
}

/** Normalize selected usage only; null/omitted native values remain explicitly unknown. */
export function semanticObservedUsage(
    batch: EmbeddingBatch,
    result: EmbeddingResult
) {
    const usage = result.usage;
    const provider = usage.providerInputTokens;
    const billed = usage.billedInputTokens ?? null;
    if (
        result.vectors.length !== batch.inputCount ||
        usage.requests !== 1 ||
        usage.estimatedInputTokens !== batch.estimatedInputTokens ||
        (provider !== null &&
            (!Number.isSafeInteger(provider) || provider < 0)) ||
        (billed !== null &&
            (!Number.isFinite(billed) ||
                billed < 0 ||
                billed > Number.MAX_SAFE_INTEGER))
    )
        throw new IndexingError('PROCESSING_FAILED');
    return {
        successfulRequests: 1,
        estimatedInputTokens: BigInt(usage.estimatedInputTokens),
        providerInputTokens: provider === null ? null : BigInt(provider),
        billedInputTokens: billed,
    };
}

/** Only domain denials may commit usage without a checkpoint; SQL/driver errors must abort/retry. */
export function isSemanticWorkDenial(error: unknown) {
    return (
        error instanceof IndexLeaseLost ||
        error instanceof CandidateObsolete ||
        error instanceof IndexingError ||
        error instanceof SemanticStateError
    );
}
