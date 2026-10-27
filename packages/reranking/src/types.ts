import type { RerankingProvider, HostedRerankingProvider } from './models';
import type { TeiRuntimeSnapshot } from './tei-snapshot';
export type { RerankingProvider } from './models';

export type RerankingConnection = {
    provider: RerankingProvider;
    endpoint: string;
    apiKey?: string | null;
};

export type TeiProbeConfiguration = RerankingConnection & { provider: 'TEI' };

export type RerankingConfiguration =
    | (RerankingConnection & {
          provider: HostedRerankingProvider;
          apiKey: string;
      })
    | (TeiProbeConfiguration & { runtimeSnapshot: TeiRuntimeSnapshot });

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
    /** One deadline for metadata, final admission, POST and the entire response; defaults to 15 seconds. */
    timeoutMs?: number;
    /**
     * Recheck current authority and persist dispatch intent immediately before sending candidate text.
     * TEI metadata is checked first. Caller refusals propagate unchanged; metadata-only probes do not invoke this hook.
     */
    beforeInference?: () => Promise<void>;
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
    | 'MODEL_CHANGED'
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
