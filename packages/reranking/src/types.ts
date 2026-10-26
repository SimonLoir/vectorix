import type { RerankingProvider } from './models';
export type { RerankingProvider } from './models';

export type RerankingConfiguration = {
    provider: RerankingProvider;
    endpoint: string;
    apiKey: string;
};

export type RerankingInput = {
    model: string;
    query: string;
    documents: readonly string[];
};

export type RerankingInputStatistics = {
    candidateCount: number;
    /** UTF-8 query bytes repeated for each candidate, plus all document bytes. */
    preparedInputBytes: number;
    serializedRequestBytes: number;
};

export type RerankingOptions = {
    signal?: AbortSignal;
    /** One deadline for the POST and the entire response; defaults to 15 seconds. */
    timeoutMs?: number;
};

export type RerankingUsage = {
    providerInputTokens: number | null;
    billedInputTokens: number | null;
    billedSearchUnits: number | null;
};

export type RerankingScore = { index: number; score: number };
export type RerankingResult = {
    results: RerankingScore[];
    usage: RerankingUsage;
    durationMs: number;
};

export type RerankingErrorCode =
    | 'INVALID_CONFIGURATION'
    | 'MODEL_UNSUPPORTED'
    | 'INPUT_TOO_LARGE'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_REJECTED'
    | 'INVALID_PROVIDER_RESPONSE';

/** Safe domain errors retain no endpoint, credential, text, provider body or cause. */
export class RerankingError extends Error {
    constructor(public readonly code: RerankingErrorCode) {
        super(`Reranking operation failed (${code}).`);
        this.name = 'RerankingError';
    }
}
