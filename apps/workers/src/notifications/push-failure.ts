export type PushFailureCategory =
    | 'VAPID_CONFIGURATION'
    | 'PROVIDER_RATE_LIMIT'
    | 'PROVIDER_SERVER_ERROR'
    | 'PROVIDER_CLIENT_ERROR'
    | 'PROVIDER_NETWORK_ERROR'
    | 'PROVIDER_UNKNOWN_ERROR';

/** Carries only allowlisted diagnostics across the delivery boundary. */
export class PushDeliveryFailure extends Error {
    readonly category: PushFailureCategory;
    readonly providerHttpStatus: number | null;
    readonly providerMessage: string | null;

    constructor(
        category: PushFailureCategory,
        providerHttpStatus: number | null = null,
        providerMessage: string | null = null
    ) {
        super(`Web Push delivery failed: ${category}`);
        this.name = 'PushDeliveryFailure';
        this.category = category;
        this.providerHttpStatus = providerHttpStatus;
        this.providerMessage = providerMessage;
    }
}

function httpStatus(error: unknown): number | null {
    if (typeof error !== 'object' || error === null || !('statusCode' in error))
        return null;
    const value = error.statusCode;
    return typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 100 &&
        value <= 599
        ? value
        : null;
}

const SAFE_WEB_PUSH_MESSAGES = new Set([
    'The subscription p256dh value must be a string.',
    'The subscription p256dh value should be 65 bytes long.',
    'The subscription auth key must be a string.',
    'The subscription auth key should be at least 16 bytes long',
    'Vapid public key should be 65 bytes long when decoded.',
    'Vapid private key should be 32 bytes long when decoded.',
]);

function safeProviderMessage(error: unknown): string | null {
    if (typeof error !== 'object' || error === null) return null;
    const response =
        'body' in error && typeof error.body === 'string' && error.body.trim()
            ? error.body
            : 'message' in error && typeof error.message === 'string'
              ? error.message
              : null;
    if (!response) return null;
    // Push services can echo the subscription or arbitrary request content.
    // Only known, static diagnostics cross the worker logging boundary.
    if (SAFE_WEB_PUSH_MESSAGES.has(response)) return response;
    if (
        /\bvapid\b/i.test(response) &&
        /\b(invalid|expired|unauthorized|rejected)\b/i.test(response)
    )
        return 'VAPID credentials rejected by push provider';
    return /\b(rate.?limit(?:ed|ing)?|too many requests|quota exceeded)\b/i.test(
        response
    )
        ? 'Push provider rate limit'
        : null;
}

export function classifyPushProviderFailure(
    error: unknown
): PushDeliveryFailure {
    const status = httpStatus(error);
    const message = safeProviderMessage(error);
    if (status !== null) {
        return new PushDeliveryFailure(
            status === 429
                ? 'PROVIDER_RATE_LIMIT'
                : status >= 500
                  ? 'PROVIDER_SERVER_ERROR'
                  : 'PROVIDER_CLIENT_ERROR',
            status,
            message
        );
    }
    const code =
        typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : null;
    return new PushDeliveryFailure(
        typeof code === 'string' &&
            [
                'ETIMEDOUT',
                'ECONNRESET',
                'ECONNREFUSED',
                'EHOSTUNREACH',
                'ENETUNREACH',
                'ENOTFOUND',
                'EAI_AGAIN',
            ].includes(code)
            ? 'PROVIDER_NETWORK_ERROR'
            : 'PROVIDER_UNKNOWN_ERROR',
        null,
        message
    );
}
