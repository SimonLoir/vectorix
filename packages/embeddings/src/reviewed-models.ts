/** Dependency-free reviewed model policy shared by native adapters and browser choices. */
/** Reviewed native text models only; newer, light, custom and multimodal profiles remain unsupported. */
export const COHERE_MODELS = {
    'embed-v4.0': {
        contextTokens: 128_000,
        defaultDimensions: 1536,
        supportedDimensions: [256, 512, 1024, 1536],
    },
    'embed-english-v3.0': {
        contextTokens: 512,
        defaultDimensions: 1024,
        supportedDimensions: [1024],
    },
    'embed-multilingual-v3.0': {
        contextTokens: 512,
        defaultDimensions: 1024,
        supportedDimensions: [1024],
    },
} as const;

export const VOYAGE_DIMENSIONS = [256, 512, 1024, 2048] as const;
const commonCapabilities = {
    contextTokens: 32_000,
    defaultDimensions: 1024,
    supportedDimensions: VOYAGE_DIMENSIONS,
} as const;
/** Reviewed general-purpose text profiles; listing these models does not contact Voyage or verify credentials. */
export const VOYAGE_MODELS = {
    'voyage-4': { ...commonCapabilities, maxBatchTokens: 320_000 },
    'voyage-4-lite': { ...commonCapabilities, maxBatchTokens: 1_000_000 },
    'voyage-4-large': { ...commonCapabilities, maxBatchTokens: 120_000 },
} as const;

/** Reviewed shortening policy up to each model's natural size; selected dimensions still need a native probe. */
export const OPENAI_MODELS = {
    'text-embedding-3-small': {
        defaultDimensions: 1536,
        maximumDimensions: 1536,
    },
    'text-embedding-3-large': {
        defaultDimensions: 3072,
        maximumDimensions: 3072,
    },
} as const;

/** Reviewed fixed-dimension aliases only; 8000 is a conservative processing policy for the documented 8k context. */
export const MISTRAL_MODELS = {
    'mistral-embed': { contextTokens: 8000, dimensions: 1024 },
    'mistral-embed-2312': { contextTokens: 8000, dimensions: 1024 },
} as const;
