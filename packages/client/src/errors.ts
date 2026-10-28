import { COMMON_ORPC_ERROR_DEFS, ORPCError } from '@orpc/client';

export type VectorixClientErrorCode =
    | 'INVALID_CONFIGURATION'
    | 'NETWORK_ERROR'
    | 'TIMEOUT'
    | 'ABORTED'
    | 'REDIRECT_REFUSED'
    | 'UNSUPPORTED_API_VERSION'
    | 'UNSUPPORTED_API_REVISION'
    | 'INVALID_RESPONSE'
    | 'RESPONSE_TOO_LARGE'
    | 'API_ERROR';
export type VectorixServerErrorCode =
    keyof typeof COMMON_ORPC_ERROR_DEFS | 'INVALID_API_KEY' | 'UNKNOWN';

/** Fixed diagnostics only. Provider/server bodies, messages, paths and causes are never retained. */
export class VectorixClientError extends Error {
    override readonly name = 'VectorixClientError';
    constructor(
        readonly code: VectorixClientErrorCode,
        readonly status?: number,
        readonly serverCode?: VectorixServerErrorCode
    ) {
        super('The Vectorix API request could not be completed.');
    }
}

/** Reduce the transport's native error to a finite code/status; never copy arbitrary wire data. */
export function sanitizeClientFailure(error: unknown): VectorixClientError {
    try {
        if (error instanceof VectorixClientError)
            return new VectorixClientError(
                error.code,
                error.status,
                error.serverCode
            );
        if (error instanceof ORPCError) {
            const code: unknown = error.code;
            const serverCode =
                typeof code === 'string' &&
                Object.hasOwn(COMMON_ORPC_ERROR_DEFS, code)
                    ? (code as keyof typeof COMMON_ORPC_ERROR_DEFS)
                    : code === 'INVALID_API_KEY'
                      ? 'INVALID_API_KEY'
                      : 'UNKNOWN';
            const status =
                Number.isInteger(error.status) &&
                error.status >= 400 &&
                error.status <= 599
                    ? error.status
                    : undefined;
            return new VectorixClientError('API_ERROR', status, serverCode);
        }
    } catch {
        /* Unknown errors, including hostile getters/proxies, stay generic. */
    }
    return new VectorixClientError('INVALID_RESPONSE');
}
