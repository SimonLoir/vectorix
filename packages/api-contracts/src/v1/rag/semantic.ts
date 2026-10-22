import { z } from 'zod';

/** Technical work/capacity limits, independent of prices or a provider's billing period. */
export const semanticQuotaValues = z
    .object({
        semanticUnitsPerDocument: z.number().int().min(1).max(8192),
        semanticPlanBytesPerDocument: z.number().int().min(1024).max(1_048_576),
        semanticPlanBytesPerOrganization: z
            .number()
            .int()
            .min(1024)
            .max(Number.MAX_SAFE_INTEGER),
        embeddingPreparedBytesPerCandidate: z
            .number()
            .int()
            .min(1024)
            .max(Number.MAX_SAFE_INTEGER),
        embeddingBatchesPerCandidate: z.number().int().min(1).max(4096),
        embeddingOutstandingPreparedBytes: z
            .number()
            .int()
            .min(1024)
            .max(Number.MAX_SAFE_INTEGER),
        embeddingOutstandingBatches: z.number().int().min(1).max(1_000_000),
    })
    .strict()
    .superRefine((limits, context) => {
        if (
            limits.semanticPlanBytesPerOrganization <
                limits.semanticPlanBytesPerDocument ||
            limits.embeddingOutstandingPreparedBytes <
                limits.embeddingPreparedBytesPerCandidate ||
            limits.embeddingOutstandingBatches <
                limits.embeddingBatchesPerCandidate
        )
            context.addIssue({
                code: 'custom',
                message:
                    'Organization capacity must admit one complete candidate allowance.',
            });
    });

// Cumulative PostgreSQL BIGINT counters must not silently lose precision in JSON.
const counter = z.string().regex(/^\d{1,19}$/);
export const semanticUsage = z.object({
    trackingSince: z.date().nullable(),
    reservedPlanBytes: counter,
    storedPlanBytes: counter,
    reservedPreparedBytes: counter,
    reservedBatches: counter,
    dispatchedPreparedBytes: counter,
    dispatchedBatches: counter,
    confirmedRequests: counter,
    estimatedInputTokens: counter,
    providerInputTokens: counter.nullable(),
    billedInputTokens: z.number().finite().nonnegative().nullable(),
    unknownProviderTokenBatches: counter,
    unknownBilledTokenBatches: counter,
    uncertainAttempts: counter,
});
export const semanticQuotaView = z.object({
    limits: semanticQuotaValues,
    usage: semanticUsage,
});

/** Optional metadata for semantic tasks; it conveys no document text or unit vectors. */
export const semanticTaskProgress = z.object({
    unitCount: z.number().int().min(0).max(8192),
    completedUnits: z.number().int().min(0).max(8192),
    sealed: z.boolean(),
    continuations: z.number().int().nonnegative(),
    reservedPreparedBytes: counter,
    reservedBatches: z.number().int().nonnegative(),
    confirmedBatches: z.number().int().nonnegative(),
    uncertainBatches: z.number().int().nonnegative(),
    estimatedInputTokens: counter,
    providerInputTokens: counter.nullable(),
    billedInputTokens: z.number().finite().nonnegative().nullable(),
});
