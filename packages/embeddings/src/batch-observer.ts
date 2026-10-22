import { createHash } from 'node:crypto';
import {
    EmbeddingError,
    type EmbeddingBatch,
    type EmbeddingOptions,
    type EmbeddingResult,
    type ModelIdentity,
} from './types';

type NativeBatchResult = {
    vectors: number[][];
    providerInputTokens: number | null;
    billedInputTokens?: number | null;
};

/**
 * Observe one validated logical batch, not individual HTTP retry attempts.
 * Native operations include their existing manifest checks and response checks.
 * The shared call signal is never renewed for hooks or later batches.
 */
export async function observeEmbeddingBatch(
    input: {
        identity: ModelIdentity;
        kind: 'document' | 'query';
        ordinal: number;
        inputOffset: number;
        inputs: readonly string[];
        options: EmbeddingOptions;
        signal: AbortSignal;
    },
    operation: () => Promise<NativeBatchResult>
): Promise<EmbeddingResult> {
    const estimatedInputTokens = input.inputs.reduce(
        (total, text) => total + Math.ceil(Buffer.byteLength(text) / 4),
        0
    );
    const observer = input.options.batchObserver;
    const metadata: EmbeddingBatch | undefined = observer
        ? Object.freeze({
              provider: input.identity.provider,
              model: input.identity.model,
              modelIdentity: input.identity.digest,
              kind: input.kind,
              ordinal: input.ordinal,
              inputOffset: input.inputOffset,
              inputCount: input.inputs.length,
              preparedInputBytes: input.inputs.reduce(
                  (total, text) => total + Buffer.byteLength(text),
                  0
              ),
              estimatedInputTokens,
              preparedInputHashVersion: 'sha256-json-strings-v1',
              preparedInputHash: createHash('sha256')
                  .update(JSON.stringify(input.inputs))
                  .digest('hex'),
          })
        : undefined;
    // Refusal is a caller failure before dispatch, not a provider failure event.
    if (metadata) await observer?.beforeBatch?.(metadata);
    let native: NativeBatchResult;
    try {
        if (metadata && input.signal.aborted)
            throw new EmbeddingError('PROVIDER_TIMEOUT');
        native = await operation();
    } catch (error) {
        if (metadata) {
            try {
                await observer?.failedBatch?.(
                    metadata,
                    error instanceof EmbeddingError
                        ? error.code
                        : 'PROVIDER_UNAVAILABLE'
                );
            } catch {
                // Preserve the native failure; no later batch can run either way.
            }
        }
        throw error;
    }
    const result: EmbeddingResult = {
        vectors: native.vectors,
        usage: {
            providerInputTokens: native.providerInputTokens,
            ...(native.billedInputTokens === undefined
                ? {}
                : { billedInputTokens: native.billedInputTokens }),
            estimatedInputTokens,
            requests: 1,
        },
    };
    // Do not recheck the signal here: validated late usage must remain recordable.
    // A checkpoint failure propagates unchanged and prevents the next dispatch.
    if (metadata) {
        await observer?.afterBatch?.(metadata, {
            vectors: result.vectors.map((vector) => [...vector]),
            usage: { ...result.usage },
        });
    }
    return result;
}
