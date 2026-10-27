export type HostedRerankingProvider = 'COHERE' | 'VOYAGE';
export type RerankingProvider = HostedRerankingProvider | 'TEI';
export type RerankingScoreKind =
    'provider_relevance' | 'normalized_cross_encoder';

export type RerankingModel = Readonly<{
    provider: RerankingProvider;
    id: string;
    contextTokens: number;
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
    Object.freeze({
        provider: 'TEI',
        id: 'BAAI/bge-reranker-v2-m3',
        contextTokens: 8192,
    }),
    Object.freeze({
        provider: 'TEI',
        id: 'Alibaba-NLP/gte-multilingual-reranker-base',
        contextTokens: 8192,
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

/** Bounded model/deployment labels are data, never URL paths or an attestation of model identity. */
export function isRerankingModelId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 200 &&
        !/\s/u.test(value) &&
        [...value].every(
            (character) => character > ' ' && character !== '\u007F'
        )
    );
}

/** Hosted names stay reviewed-only; TEI labels must additionally match the native endpoint's reported model. */
export function supportsRerankingModel(
    provider: RerankingProvider,
    model: unknown
) {
    return provider === 'TEI'
        ? isRerankingModelId(model)
        : listRerankingModels(provider).some((entry) => entry.id === model);
}

/** Normalization gives a bounded ranking score, not a calibrated probability or a cross-model confidence scale. */
export function rerankingScoreKind(
    provider: RerankingProvider
): RerankingScoreKind {
    return provider === 'TEI'
        ? 'normalized_cross_encoder'
        : 'provider_relevance';
}
