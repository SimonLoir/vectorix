interface HostedModel {
    model: string;
    dimensions: readonly number[];
    defaultDimensions: number;
}
interface HostedCatalog {
    models: readonly HostedModel[];
}

/**
 * Browser-only profile choices, aligned with the reviewed native Cohere/Voyage
 * catalogs in @repo/embeddings. Never import that Node-only package into clients.
 * This list neither discovers model availability nor validates credentials.
 */
export function hostedModelCatalog(provider: string): HostedCatalog | null {
    if (provider === 'COHERE') return cohereCatalog;
    if (provider === 'VOYAGE') return voyageCatalog;
    return null;
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
