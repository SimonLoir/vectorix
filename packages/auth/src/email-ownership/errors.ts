import { APIError } from 'better-auth/api';

const failures = {
    EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED: [
        'FORBIDDEN',
        'Verify the current account address before requesting an email change.',
    ],
    EMAIL_VERIFICATION_UNAVAILABLE: [
        'SERVICE_UNAVAILABLE',
        'Email verification is temporarily unavailable.',
    ],
    EMAIL_VERIFICATION_SESSION_REQUIRED: [
        'UNAUTHORIZED',
        'Sign in to verify this address.',
    ],
    EMAIL_VERIFICATION_ACCOUNT_MISMATCH: [
        'FORBIDDEN',
        'Sign in to the account that requested this verification.',
    ],
    EMAIL_VERIFICATION_INVALID_TOKEN: [
        'BAD_REQUEST',
        'This verification link is invalid or expired.',
    ],
    EMAIL_VERIFICATION_STALE: [
        'CONFLICT',
        'This verification no longer matches the account.',
    ],
    EMAIL_VERIFICATION_EMAIL_MISMATCH: [
        'BAD_REQUEST',
        'Only the current account address can be verified.',
    ],
    EMAIL_VERIFICATION_INVALID_CALLBACK: [
        'BAD_REQUEST',
        'The verification return path is invalid.',
    ],
} as const;

/** Fixed public failures never include a token, address, provider response or configuration. */
export function emailOwnershipError(code: keyof typeof failures): APIError {
    const [status, message] = failures[code];
    return new APIError(status, { code, message });
}
