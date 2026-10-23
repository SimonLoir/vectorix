import { ORPCError } from '@orpc/server';

/**
 * Preserve coded errors and the native unauthorized signal without inspecting
 * arbitrary error text. A thrown primitive or unknown failure remains a generic
 * server error; observation belongs to the HTTP runtime, not the shared guard.
 */
export function normalizeAuthorizationError(
    error: unknown
): ORPCError<string, unknown> {
    try {
        if (error instanceof ORPCError) return error;
        if (typeof error === 'object' && error !== null) {
            // Read data properties only: an arbitrary thrown getter is not trusted.
            const status = Object.getOwnPropertyDescriptor(error, 'status');
            if (status && 'value' in status && status.value === 'UNAUTHORIZED')
                return new ORPCError('UNAUTHORIZED');
        }
    } catch {
        // Proxies and malformed thrown values receive the same fixed 500.
    }
    return new ORPCError('INTERNAL_SERVER_ERROR', {
        message: 'Internal server error',
    });
}
