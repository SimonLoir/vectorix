/** Finite translation keys for shared RPC failures, independent of server messages. */
export type RequestErrorKey =
    | 'permission'
    | 'session'
    | 'conflict'
    | 'notFound'
    | 'invalidInput'
    | 'rateLimited'
    | 'tooLarge'
    | 'unsupportedFormat'
    | 'unavailable'
    | 'generic';

/**
 * Read only an own data property: error messages, details, causes, inherited
 * fields and accessors never select or become UI copy. Unexpected objects and
 * proxies fail closed without making error rendering throw.
 */
function ownCode(error: unknown): unknown {
    if (!error || typeof error !== 'object') return undefined;
    try {
        if (Array.isArray(error)) return undefined;
        const field = Object.getOwnPropertyDescriptor(error, 'code');
        return field && 'value' in field ? field.value : undefined;
    } catch {
        return undefined;
    }
}

/** Map public RPC codes to complete localized messages; unknown codes stay generic. */
export function requestErrorKey(error: unknown): RequestErrorKey {
    switch (ownCode(error)) {
        case 'FORBIDDEN':
            return 'permission';
        case 'UNAUTHORIZED':
            return 'session';
        case 'CONFLICT':
        case 'PRECONDITION_FAILED':
            return 'conflict';
        case 'NOT_FOUND':
            return 'notFound';
        case 'BAD_REQUEST':
        case 'UNPROCESSABLE_CONTENT':
            return 'invalidInput';
        case 'TOO_MANY_REQUESTS':
            return 'rateLimited';
        case 'PAYLOAD_TOO_LARGE':
            return 'tooLarge';
        case 'UNSUPPORTED_MEDIA_TYPE':
            return 'unsupportedFormat';
        case 'TIMEOUT':
        case 'BAD_GATEWAY':
        case 'SERVICE_UNAVAILABLE':
        case 'GATEWAY_TIMEOUT':
            return 'unavailable';
        default:
            return 'generic';
    }
}
