import type {
    EmbeddingNumericObserver,
    EmbeddingProvider,
} from '@repo/embeddings';

export const workloads = [
    'EXTRACTION',
    'INDEX_STRUCTURE',
    'INDEX_TOKEN',
    'INDEX_SEMANTIC',
    'SEARCH_LEXICAL',
    'SEARCH_VECTOR',
    'SEARCH_HYBRID',
] as const;
export type TelemetryWorkload = (typeof workloads)[number];
export type TelemetryProvider = EmbeddingProvider | 'NONE';
export type TelemetryTags = Readonly<{
    organizationId: string;
    workload: TelemetryWorkload;
    provider: TelemetryProvider;
}>;
export const counterFields = [
    'recordedStarts',
    'recordedSuccesses',
    'recordedFailures',
    'recordedContinuations',
    'recordedSupersessions',
    'recordedDenials',
    'nativeStarts',
    'nativeValidatedBatches',
    'nativeFailedBatches',
    'validatedVectors',
    'dispatchedPreparedBytes',
    'validatedPreparedBytes',
    'validatedEstimatedInputTokens',
    'knownProviderInputTokens',
    'unknownProviderTokenBatches',
    'unknownBilledTokenBatches',
] as const;
export type CounterField = (typeof counterFields)[number];
export const failureClasses = [
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
] as const;
export type TelemetryFailure = (typeof failureClasses)[number];
export const phaseLimits = [
    1000,
    5000,
    10_000,
    25_000,
    50_000,
    100_000,
    250_000,
    500_000,
    1_000_000,
    2_500_000,
    5_000_000,
    10_000_000,
    30_000_000,
    90_000_000,
    300_000_000,
    null,
] as const;
export const workloadPhases = {
    EXTRACTION: [
        'SOURCE_READ',
        'PARSE_EXTRACT',
        'ARTIFACT_WRITE',
        'CATALOG_PUBLISH',
        'EXECUTION_TOTAL',
    ],
    INDEX_STRUCTURE: [
        'SOURCE_READ',
        'PLAN',
        'MATERIALIZE_SEAL',
        'FINAL_EMBED',
        'VECTOR_WRITE_SEAL',
        'CATALOG_PUBLISH',
        'EXECUTION_TOTAL',
    ],
    INDEX_TOKEN: [
        'SOURCE_READ',
        'PLAN',
        'MATERIALIZE_SEAL',
        'FINAL_EMBED',
        'VECTOR_WRITE_SEAL',
        'CATALOG_PUBLISH',
        'EXECUTION_TOTAL',
    ],
    INDEX_SEMANTIC: [
        'SOURCE_READ',
        'PLAN',
        'MATERIALIZE_SEAL',
        'FINAL_EMBED',
        'VECTOR_WRITE_SEAL',
        'CATALOG_PUBLISH',
        'EXECUTION_TOTAL',
        'BOUNDARY_EMBED',
    ],
    SEARCH_LEXICAL: [
        'PREFLIGHT',
        'LEXICAL',
        'FUSION_HYDRATE',
        'SERVICE_TOTAL',
        'INTERNAL_PHASE_UNION',
    ],
    SEARCH_VECTOR: [
        'PREFLIGHT',
        'QUERY_EMBED',
        'VECTOR',
        'FUSION_HYDRATE',
        'SERVICE_TOTAL',
        'INTERNAL_PHASE_UNION',
    ],
    SEARCH_HYBRID: [
        'PREFLIGHT',
        'QUERY_EMBED',
        'LEXICAL',
        'VECTOR',
        'FUSION_HYDRATE',
        'SERVICE_TOTAL',
        'INTERNAL_PHASE_UNION',
    ],
} as const;
export type TelemetryPhase = (typeof workloadPhases)[TelemetryWorkload][number];
export type PhaseStats = Readonly<{
    samples: bigint;
    sumMicros: bigint;
    maxMicros: bigint;
    buckets: readonly bigint[];
}>;
export type TelemetryDelta = Readonly<
    Partial<Record<CounterField, bigint>> & {
        knownBilledInputTokens?: number;
        sourceReadBytes?: bigint;
        artifactWrittenBytes?: bigint;
        phaseStats?: Readonly<Partial<Record<TelemetryPhase, PhaseStats>>>;
        failureCounts?: Readonly<Partial<Record<TelemetryFailure, bigint>>>;
    }
>;
export type TelemetryOutcome =
    'SUCCESS' | 'FAILURE' | 'CONTINUATION' | 'SUPERSEDED' | 'DENIED';
export type WorkerLane = 'NOTIFICATIONS' | 'DOCUMENTS' | 'INDEXING';
export type WorkerFailure =
    'SCAN_FAILED' | 'DATABASE_UNAVAILABLE' | 'REDIS_UNAVAILABLE' | 'UNKNOWN';
export interface TelemetryExecution {
    phase(phase: TelemetryPhase, startedAt?: number): () => void;
    measure<T>(phase: TelemetryPhase, operation: () => Promise<T>): Promise<T>;
    sourceRead(bytes: number): void;
    artifactWritten(bytes: number): void;
    readonly nativeObserver: EmbeddingNumericObserver;
    finish(outcome: TelemetryOutcome, failure?: TelemetryFailure): void;
}
export interface TelemetryScan {
    finish(outcome: 'RETURNED' | 'THREW', failure?: WorkerFailure): void;
}
