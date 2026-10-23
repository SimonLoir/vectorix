import {
    VECTORIX_CSRF_HEADER,
    VECTORIX_CSRF_VALUE,
} from '@repo/api/transport-security';

const forwardedAuthHeaders = [
    'Cookie',
    'Authorization',
    'x-api-key',
    'Vectorix-Expected-Organization-Id',
] as const;

/**
 * Forward only authentication and tenant pinning for a server-rendered RPC call.
 * Navigation metadata describes the incoming page request, so it must not become
 * RPC Origin, Fetch Metadata, forwarding or body headers. The marker belongs to
 * this RPC client and never inherits a value supplied by the incoming request.
 */
export function buildSsrRpcHeaders(
    incoming: Pick<Headers, 'get'>
): Record<string, string> {
    const outgoing: Record<string, string> = {
        [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
    };
    for (const name of forwardedAuthHeaders) {
        const value = incoming.get(name);
        if (value !== null) outgoing[name] = value;
    }
    return outgoing;
}
