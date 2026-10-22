interface DimensionRange {
    kind: 'RANGE';
    minimum: number;
    maximum: number;
    step: 1;
}
type HostedModel = {
    model: string;
    defaultDimensions: number;
} & (
    | { dimensions: readonly number[]; dimensionCapability?: never }
    | { dimensions?: never; dimensionCapability: DimensionRange }
);
interface HostedCatalog {
    models: readonly HostedModel[];
}

/**
 * Browser-only profile choices, aligned with the reviewed native hosted
 * catalogs in @repo/embeddings. Never import that Node-only package into clients.
 * OpenAI ranges describe Vectorix's reviewed shortening policy, not a claimed
 * provider hard maximum. This list never verifies availability or credentials.
 */
export function hostedModelCatalog(provider: string): HostedCatalog | null {
    if (provider === 'COHERE') return cohereCatalog;
    if (provider === 'VOYAGE') return voyageCatalog;
    if (provider === 'OPENAI') return openaiCatalog;
    return null;
}

/** Preserve any compatible saved/user-selected size, including nonstandard range values. */
export function supportsHostedDimensions(model: HostedModel, value: number) {
    if (!Number.isInteger(value)) return false;
    if (model.dimensionCapability) {
        return (
            value >= model.dimensionCapability.minimum &&
            value <= model.dimensionCapability.maximum
        );
    }
    return model.dimensions.includes(value);
}

const cohereCatalog: HostedCatalog = {
    models: [
        {
            model: 'embed-v4.0',
            dimensions: [256, 512, 1024, 1536],
            defaultDimensions: 1536,
        },
        {
            model: 'embed-english-v3.0',
            dimensions: [1024],
            defaultDimensions: 1024,
        },
        {
            model: 'embed-multilingual-v3.0',
            dimensions: [1024],
            defaultDimensions: 1024,
        },
    ],
};
const voyageCatalog: HostedCatalog = {
    models: [
        {
            model: 'voyage-4',
            dimensions: [256, 512, 1024, 2048],
            defaultDimensions: 1024,
        },
        {
            model: 'voyage-4-lite',
            dimensions: [256, 512, 1024, 2048],
            defaultDimensions: 1024,
        },
        {
            model: 'voyage-4-large',
            dimensions: [256, 512, 1024, 2048],
            defaultDimensions: 1024,
        },
    ],
};
const openaiCatalog: HostedCatalog = {
    models: [
        {
            model: 'text-embedding-3-small',
            dimensionCapability: {
                kind: 'RANGE',
                minimum: 1,
                maximum: 1536,
                step: 1,
            },
            defaultDimensions: 1536,
        },
        {
            model: 'text-embedding-3-large',
            dimensionCapability: {
                kind: 'RANGE',
                minimum: 1,
                maximum: 3072,
                step: 1,
            },
            defaultDimensions: 3072,
        },
    ],
};
