import {
    COHERE_MODELS,
    VOYAGE_MODELS,
    OPENAI_MODELS,
    MISTRAL_MODELS,
} from './reviewed-models';

export type ReviewedEmbeddingProvider =
    'COHERE' | 'VOYAGE' | 'OPENAI' | 'MISTRAL';

export type ReviewedEmbeddingProfile = Readonly<{
    provider: ReviewedEmbeddingProvider;
    model: string;
    defaultDimensions: number;
    contextTokens: number;
}> &
    (
        | Readonly<{
              dimensions: readonly number[];
              dimensionCapability?: never;
          }>
        | Readonly<{
              dimensions?: never;
              dimensionCapability: Readonly<{
                  kind: 'RANGE';
                  minimum: number;
                  maximum: number;
                  step: 1;
              }>;
          }>
    );

export interface RecommendedEmbeddingDefaults {
    readonly dimensions: number;
    readonly embeddingPreset: 'GENERIC' | 'EMBEDDING_GEMMA';
    readonly preparation: '';
    readonly metric: 'cosine';
    readonly numericType: 'float32';
    readonly indexType: 'DISKANN';
}

/**
 * Return reviewed local choices without I/O, credentials, availability or weight
 * claims. Ollama requires saved-binding discovery and has no static capability
 * catalog. Import this subpath rather than the Node-only package root in clients.
 */
export function listReviewedEmbeddingProfiles(
    provider: string
): readonly ReviewedEmbeddingProfile[] {
    if (provider === 'COHERE')
        return Object.entries(COHERE_MODELS).map(([model, caps]) => ({
            provider,
            model,
            contextTokens: caps.contextTokens,
            defaultDimensions: caps.defaultDimensions,
            dimensions: [...caps.supportedDimensions],
        }));
    if (provider === 'VOYAGE')
        return Object.entries(VOYAGE_MODELS).map(([model, caps]) => ({
            provider,
            model,
            contextTokens: caps.contextTokens,
            defaultDimensions: caps.defaultDimensions,
            dimensions: [...caps.supportedDimensions],
        }));
    if (provider === 'OPENAI')
        return Object.entries(OPENAI_MODELS).map(([model, caps]) => ({
            provider,
            model,
            contextTokens: 8192,
            defaultDimensions: caps.defaultDimensions,
            dimensionCapability: {
                kind: 'RANGE',
                minimum: 1,
                maximum: caps.maximumDimensions,
                step: 1,
            },
        }));
    if (provider === 'MISTRAL')
        return Object.entries(MISTRAL_MODELS).map(([model, caps]) => ({
            provider,
            model,
            contextTokens: caps.contextTokens,
            defaultDimensions: caps.dimensions,
            dimensions: [caps.dimensions],
        }));
    return [];
}

/** Match exact hosted IDs only; no aliases, tags or unreviewed capabilities are inferred. */
export function getReviewedEmbeddingProfile(provider: string, model: string) {
    return listReviewedEmbeddingProfiles(provider).find(
        (profile) => profile.model === model
    );
}

/** Validate reviewed dimensions without replacing a compatible saved or manual choice. */
export function supportsReviewedEmbeddingDimensions(
    profile: ReviewedEmbeddingProfile,
    dimensions: number
) {
    if (!Number.isInteger(dimensions)) return false;
    const range = profile.dimensionCapability;
    return range
        ? dimensions >= range.minimum && dimensions <= range.maximum
        : profile.dimensions.includes(dimensions);
}

/**
 * Suggest creation defaults only. Existing saved profiles must retain their own
 * configuration. The two exact EmbeddingGemma names are an unverified local
 * recommendation, not model discovery or capability evidence: the native probe
 * still checks installed weights, architecture and the selected dimensions.
 * Unknown Ollama models require discovery or explicit advanced configuration.
 */
export function getRecommendedEmbeddingDefaults(
    provider: string,
    model: string
): RecommendedEmbeddingDefaults | undefined {
    const profile = getReviewedEmbeddingProfile(provider, model);
    const embeddingGemma =
        provider === 'OLLAMA' &&
        (model === 'embeddinggemma' || model === 'embeddinggemma:latest');
    if (!profile && !embeddingGemma) return undefined;
    return {
        dimensions: profile?.defaultDimensions ?? 768,
        embeddingPreset: embeddingGemma ? 'EMBEDDING_GEMMA' : 'GENERIC',
        preparation: '',
        metric: 'cosine',
        numericType: 'float32',
        // HNSW float32 stops at 2,000 dimensions; DiskANN also covers natural
        // OpenAI large output and the reviewed 2,048-dimensional Voyage choice.
        indexType: 'DISKANN',
    };
}
