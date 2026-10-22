import { oc } from '@orpc/contract';
import { z } from 'zod';

/** Exact decimal counters, independent of Prisma and JavaScript number rounding. */
export const telemetryCounter = z
    .string()
    .max(19)
    .refine(
        (value) =>
            value.length <= 19 &&
            /^(0|[1-9]\d*)$/.test(value) &&
            BigInt(value) <= 9_223_372_036_854_775_807n,
        'Expected a canonical nonnegative signed-64-bit decimal counter.'
    );
export const telemetryWindow = z.enum(['24H', '7D', '30D']);
export const telemetryInput = z
    .object({ window: telemetryWindow.default('24H') })
    .strict()
    .prefault({});
export const telemetryWorkload = z.enum([
    'EXTRACTION',
    'INDEX_STRUCTURE',
    'INDEX_TOKEN',
    'INDEX_SEMANTIC',
    'SEARCH_LEXICAL',
    'SEARCH_VECTOR',
    'SEARCH_HYBRID',
]);
export const telemetryProvider = z.enum([
    'NONE',
    'OLLAMA',
    'COHERE',
    'VOYAGE',
    'OPENAI',
    'MISTRAL',
]);
export const telemetryPhase = z.enum([
    'SOURCE_READ',
    'PARSE_EXTRACT',
    'ARTIFACT_WRITE',
    'CATALOG_PUBLISH',
    'EXECUTION_TOTAL',
    'PLAN',
    'MATERIALIZE_SEAL',
    'FINAL_EMBED',
    'VECTOR_WRITE_SEAL',
    'BOUNDARY_EMBED',
    'PREFLIGHT',
    'QUERY_EMBED',
    'LEXICAL',
    'VECTOR',
    'FUSION_HYDRATE',
    'SERVICE_TOTAL',
    'INTERNAL_PHASE_UNION',
]);
export const telemetryFailure = z.enum([
    'ACCESS',
    'PROFILE',
    'CREDENTIALS',
    'PROVIDER',
    'STORAGE',
    'SOURCE',
    'VECTOR',
    'QUOTA',
    'LEASE',
    'INPUT',
    'PROCESSING',
    'OTHER',
]);

/** Recorded work, not a conservation ledger, unique-document count or invoice. */
export const telemetryCounters = z.object({
    recordedStarts: telemetryCounter,
    recordedSuccesses: telemetryCounter,
    recordedFailures: telemetryCounter,
    recordedContinuations: telemetryCounter,
    recordedSupersessions: telemetryCounter,
    recordedDenials: telemetryCounter,
    nativeStarts: telemetryCounter,
    nativeValidatedBatches: telemetryCounter,
    nativeFailedBatches: telemetryCounter,
    validatedVectors: telemetryCounter.nullable(),
    dispatchedPreparedBytes: telemetryCounter,
    validatedPreparedBytes: telemetryCounter,
    validatedEstimatedInputTokens: telemetryCounter.nullable(),
    knownProviderInputTokens: telemetryCounter.nullable(),
    unknownProviderTokenBatches: telemetryCounter,
    knownBilledInputTokens: z.number().finite().nonnegative().nullable(),
    unknownBilledTokenBatches: telemetryCounter,
    sourceReadBytes: telemetryCounter.nullable(),
    artifactWrittenBytes: telemetryCounter.nullable(),
});
const quantileBounds = z.object({
    lowerMicros: telemetryCounter,
    upperMicros: telemetryCounter.nullable(),
});
export const telemetryPhaseSummary = z.object({
    name: telemetryPhase,
    samples: telemetryCounter,
    totalMicros: telemetryCounter,
    maxMicros: telemetryCounter,
    meanMicros: telemetryCounter,
    p50: quantileBounds,
    p95: quantileBounds,
});
const recordedState = z.enum([
    'NOT_TRACKED',
    'NO_RECORDED_ACTIVITY',
    'RECORDED',
]);

/** Bounded technical aggregates contain no query, content, resource or actor IDs. */
export const telemetrySummary = z.object({
    observedAt: z.date(),
    windowStart: z.date(),
    windowEnd: z.date(),
    retainedFrom: z.date(),
    hourCount: z.number().int().min(1).max(720),
    coverage: z.literal('BEST_EFFORT'),
    state: recordedState,
    tracking: z.object({
        trackingSince: z.date().nullable(),
        lastRecordedAt: z.date().nullable(),
        knownGapReports: telemetryCounter,
        lastKnownGapReportedAt: z.date().nullable(),
    }),
    totals: telemetryCounters.nullable(),
    hourly: z
        .array(
            z.object({
                bucketStart: z.date(),
                state: recordedState,
                counters: telemetryCounters.nullable(),
            })
        )
        .max(720),
    dimensions: z
        .array(
            z.object({
                workload: telemetryWorkload,
                provider: telemetryProvider,
                counters: telemetryCounters,
                phases: z.array(telemetryPhaseSummary).max(8),
                failures: z
                    .array(
                        z.object({
                            code: telemetryFailure,
                            count: telemetryCounter,
                        })
                    )
                    .max(12),
            })
        )
        .max(27),
});

export const telemetryContract = {
    summary: oc
        .route({
            method: 'GET',
            path: '/telemetry',
            description:
                'Read bounded best-effort recorded organization activity; current sessions with quota-read permission only',
        })
        .input(telemetryInput)
        .output(telemetrySummary),
};
