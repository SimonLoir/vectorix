import { z } from 'zod';
import { isRerankingModelId, RERANKING_LIMITS } from './models';
import { RerankingError } from './types';

const modelId = z.string().refine(isRerankingModelId);
const modelRevision = z.string().min(1).max(128).refine(isRerankingModelId);
const maxInputLength = z.number().int().min(1).max(10_000_000);
const maxClientBatchSize = z.number().int().min(1).max(100_000);
const runtimeVersion = z.string().min(1).max(64).refine(isRerankingModelId);
const snapshot = z
    .object({
        protocolVersion: z.literal('native-tei-v1'),
        modelId,
        modelRevision: modelRevision.nullable(),
        modelType: z.literal('reranker'),
        maxInputLength,
        maxClientBatchSize,
        runtimeVersion,
        modelDtype: z.string().min(1).max(64).refine(isRerankingModelId),
    })
    .strict()
    .readonly();

/** Endpoint-reported metadata only. Neither a revision label nor this snapshot verifies weight bytes. */
export type TeiRuntimeSnapshot = z.output<typeof snapshot>;

/** Read saved JSON without retaining malformed input or leaking Zod diagnostics. */
export function parseTeiRuntimeSnapshot(value: unknown): TeiRuntimeSnapshot {
    const parsed = snapshot.safeParse(value);
    if (!parsed.success) throw new RerankingError('INVALID_CONFIGURATION');
    return parsed.data;
}

const info = z.object({
    ['model_id']: modelId,
    ['model_sha']: modelRevision.nullish(),
    ['model_type']: z
        .object({
            reranker: z.object({
                ['id2label']: z
                    .record(z.string(), z.string())
                    .refine(
                        (labels) =>
                            Object.keys(labels).length === 1 &&
                            Object.hasOwn(labels, '0')
                    ),
                ['label2id']: z
                    .record(z.string(), z.number().int())
                    .refine(
                        (labels) =>
                            Object.keys(labels).length === 1 &&
                            Object.values(labels)[0] === 0
                    ),
            }),
        })
        .strict(),
    ['max_input_length']: maxInputLength,
    ['max_client_batch_size']: maxClientBatchSize,
    ['max_concurrent_requests']: maxClientBatchSize,
    version: runtimeVersion,
    ['model_dtype']: z.string().min(1).max(64).refine(isRerankingModelId),
});

/** Normalize only the bounded native metadata needed for a compatible single-label cross-encoder. */
export function parseTeiInfo(
    value: unknown,
    candidatePool?: number
): TeiRuntimeSnapshot {
    const parsed = info.safeParse(value);
    if (!parsed.success) throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    const data = parsed.data;
    // TEI consumes one live inference permit per pair; this is admission capacity, not saved model identity.
    if (
        candidatePool !== undefined &&
        candidatePool > data.max_concurrent_requests
    )
        throw new RerankingError('INPUT_TOO_LARGE');
    return Object.freeze({
        protocolVersion: 'native-tei-v1',
        modelId: data.model_id,
        modelRevision: data.model_sha ?? null,
        modelType: 'reranker',
        maxInputLength: data.max_input_length,
        maxClientBatchSize: data.max_client_batch_size,
        runtimeVersion: data.version,
        modelDtype: data.model_dtype,
    });
}

/** A TEI POST cannot select a model. Its deployment must serve the exact saved model and fit one request. */
export function assertTeiModelAndPool(
    value: TeiRuntimeSnapshot,
    model: string,
    count: number
) {
    if (value.modelId !== model) throw new RerankingError('MODEL_CHANGED');
    if (
        !Number.isInteger(count) ||
        count < 1 ||
        count > RERANKING_LIMITS.documents ||
        count > value.maxClientBatchSize
    )
        throw new RerankingError('INPUT_TOO_LARGE');
}

/** Compare reported identity and execution limits, without treating a metadata match as weight attestation. */
export function matchesTeiRuntime(
    saved: TeiRuntimeSnapshot,
    live: TeiRuntimeSnapshot
) {
    return (
        saved.protocolVersion === live.protocolVersion &&
        saved.modelId === live.modelId &&
        saved.modelRevision === live.modelRevision &&
        saved.modelType === live.modelType &&
        saved.modelDtype === live.modelDtype &&
        saved.runtimeVersion === live.runtimeVersion &&
        saved.maxInputLength === live.maxInputLength &&
        saved.maxClientBatchSize === live.maxClientBatchSize
    );
}
