import { createHash } from 'node:crypto';
import {
    EmbeddingError,
    type EmbeddingBatch,
    type EmbeddingOptions,
    type EmbeddingResult,
    type ModelIdentity,
    type EmbeddingNumericEvent,
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
    const numericObserver = input.options.numericObserver;
    const preparedInputBytes =
        observer || numericObserver
            ? input.inputs.reduce(
                  (total, text) => total + Buffer.byteLength(text),
                  0
              )
            : 0;
    const metadata: EmbeddingBatch | undefined = observer
        ? Object.freeze({
              provider: input.identity.provider,
              model: input.identity.model,
              modelIdentity: input.identity.digest,
              kind: input.kind,
              ordinal: input.ordinal,
              inputOffset: input.inputOffset,
              inputCount: input.inputs.length,
              preparedInputBytes,
              estimatedInputTokens,
              preparedInputHashVersion: 'sha256-json-strings-v1',
              preparedInputHash: createHash('sha256')
                  .update(JSON.stringify(input.inputs))
                  .digest('hex'),
          })
        : undefined;
    // Refusal is a caller failure before dispatch, not a provider failure event.
    if (metadata) await observer?.beforeBatch?.(metadata);
    const observe = (event: EmbeddingNumericEvent) => {
        try {
            const returned: unknown = numericObserver?.(Object.freeze(event));
            // The contract is synchronous, but JS/void typing can still return an accidental promise.
            // Never await it or let its rejection change process/domain behavior.
            if (
                returned &&
                (typeof returned === 'object' ||
                    typeof returned === 'function') &&
                'then' in returned
            )
                void Promise.resolve(returned).catch(() => {});
        } catch {
            // A telemetry failure cannot affect admission, native work or mandatory settlement.
        }
    };
    const numeric = {
        provider: input.identity.provider,
        kind: input.kind,
        inputCount: input.inputs.length,
        preparedInputBytes,
    };
    let started: number | undefined;
    let native: NativeBatchResult;
    try {
        // Abort still reaches the mandatory failure hook after reservation, but is not a native start.
        if ((metadata || numericObserver) && input.signal.aborted)
            throw new EmbeddingError('PROVIDER_TIMEOUT');
        started = performance.now();
        if (numericObserver) observe({ ...numeric, outcome: 'START' });
        native = await operation();
    } catch (error) {
        if (numericObserver && started !== undefined)
            observe({
                ...numeric,
                outcome: 'FAILED',
                durationMicros: Math.max(
                    0,
                    Math.round((performance.now() - started) * 1000)
                ),
                failure:
                    error instanceof EmbeddingError
                        ? error.code
                        : 'PROVIDER_UNAVAILABLE',
            });
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
    if (numericObserver && started !== undefined)
        observe({
            ...numeric,
            outcome: 'VALIDATED',
            durationMicros: Math.max(
                0,
                Math.round((performance.now() - started) * 1000)
            ),
            validatedVectors: native.vectors.length,
            estimatedInputTokens,
            providerInputTokens: native.providerInputTokens,
            billedInputTokens: native.billedInputTokens ?? null,
        });
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
