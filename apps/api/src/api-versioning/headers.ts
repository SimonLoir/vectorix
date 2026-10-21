import {
    VECTORIX_API_REVISION_HEADER,
    VECTORIX_API_VERSION_HEADER,
    type VectorixApiVersion,
} from '@repo/api/versioning';

export const API_VERSION_RESPONSE_HEADERS = [
    VECTORIX_API_VERSION_HEADER,
    VECTORIX_API_REVISION_HEADER,
    'Deprecation',
] as const;

/**
 * Adds the resolved contract metadata to any response, including oRPC errors
 * and 404 responses produced below a versioned transport prefix.
 */
export function withApiVersionHeaders(
    response: Response,
    version: VectorixApiVersion
) {
    const headers = new Headers(response.headers);

    headers.set(VECTORIX_API_VERSION_HEADER, String(version.major));
    headers.set(VECTORIX_API_REVISION_HEADER, String(version.revision));

    if (version.status === 'deprecated') {
        headers.set('Deprecation', 'true');
    }

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}
