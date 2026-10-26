export type RerankingProvider = 'COHERE' | 'VOYAGE';

export type RerankingModel = Readonly<{
    provider: RerankingProvider;
    id: string;
    contextTokens: 32_000;
}>;

/** Reviewed names and published context caps, not an attestation of hosted weights. */
export const RERANKING_MODELS: readonly RerankingModel[] = Object.freeze([
    Object.freeze({
        provider: 'COHERE',
        id: 'rerank-v5.0-fast',
        contextTokens: 32_000,
    }),
    Object.freeze({
        provider: 'COHERE',
        id: 'rerank-v5.0-pro',
        contextTokens: 32_000,
    }),
    Object.freeze({
        provider: 'VOYAGE',
        id: 'rerank-3',
        contextTokens: 32_000,
    }),
    Object.freeze({
        provider: 'VOYAGE',
        id: 'rerank-3-lite',
        contextTokens: 32_000,
    }),
]);

export const RERANKING_LIMITS = Object.freeze({
    documents: 100,
    queryBytes: 4000,
    documentBytes: 20_000,
    repeatedInputBytes: 512_000,
    requestBytes: 2 * 1024 * 1024,
    responseBytes: 256 * 1024,
    timeoutMs: 15_000,
});

/** Returns the reviewed entries; no discovery, configuration or native transport is imported. */
export function listRerankingModels(
    provider: RerankingProvider
): readonly RerankingModel[] {
    return RERANKING_MODELS.filter((model) => model.provider === provider);
}
