import { createEndpointAllowlist } from '@repo/storage/endpoint-allowlist';
import type { RerankingProvider } from '@repo/reranking/models';
import { rerankError } from './errors';

/** Normalize a root native reranking destination without changing its authority. */
export function normalizeRerankingEndpoint(value: string) {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw rerankError('CREDENTIALS_INVALID');
    }
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== '/'
    )
        throw rerankError('CREDENTIALS_INVALID');
    return url.origin;
}
function endpoints(provider: RerankingProvider) {
    return createEndpointAllowlist({
        defaultVariable: `VECTORIX_DEFAULT_${provider}_ENDPOINT`,
        allowedVariable: 'VECTORIX_RERANKING_ALLOWED_ENDPOINTS',
        normalize: normalizeRerankingEndpoint,
    });
}
const policies = {
    COHERE: endpoints('COHERE'),
    VOYAGE: endpoints('VOYAGE'),
    TEI: endpoints('TEI'),
};

/** Exact fixed-provider operator allowlists are re-read before external dispatch. */
export function assertRerankingEndpoint(
    provider: RerankingProvider,
    endpoint: string
) {
    if (
        !Object.hasOwn(policies, provider) ||
        !policies[provider].allows(endpoint, {
            defaultEndpoint:
                process.env[`VECTORIX_DEFAULT_${provider}_ENDPOINT`],
            allowedEndpoints: process.env.VECTORIX_RERANKING_ALLOWED_ENDPOINTS,
        })
    )
        throw rerankError('CREDENTIALS_INVALID');
}
