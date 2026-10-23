/** Finite UI failures never include native messages, session tokens or browser details. */
export type SecurityErrorKey =
    | 'generic'
    | 'refreshRequired'
    | 'busy'
    | 'invalidPassword'
    | 'passwordTooShort'
    | 'passwordTooLong'
    | 'passwordUnavailable'
    | 'sessionRequired'
    | 'freshSessionRequired'
    | 'passkeyCancelled'
    | 'passkeyAlreadyRegistered'
    | 'passkeyUnavailable'
    | 'passkeyNotFound'
    | 'cleanupRequired';

export function securityErrorKey(value: unknown): SecurityErrorKey {
    if (value instanceof SecurityRequestError) return value.key;
    if (typeof value !== 'object' || value === null || !('code' in value))
        return 'generic';
    switch (value.code) {
        case 'INVALID_PASSWORD':
            return 'invalidPassword';
        case 'PASSWORD_TOO_SHORT':
            return 'passwordTooShort';
        case 'PASSWORD_TOO_LONG':
            return 'passwordTooLong';
        case 'CREDENTIAL_ACCOUNT_NOT_FOUND':
            return 'passwordUnavailable';
        case 'UNAUTHORIZED':
        case 'SESSION_REQUIRED':
        case 'SESSION_EXPIRED':
            return 'sessionRequired';
        case 'SESSION_NOT_FRESH':
            return 'freshSessionRequired';
        case 'REGISTRATION_CANCELLED':
        case 'AUTH_CANCELLED':
        case 'ERROR_CEREMONY_ABORTED':
            return 'passkeyCancelled';
        case 'PREVIOUSLY_REGISTERED':
        case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
            return 'passkeyAlreadyRegistered';
        case 'ERROR_AUTHENTICATOR_NO_RESIDENT_KEY':
        case 'ERROR_AUTHENTICATOR_NO_USER_VERIFICATION':
        case 'ERROR_BROWSER_NOT_SUPPORTED':
            return 'passkeyUnavailable';
        case 'PASSKEY_NOT_FOUND':
            return 'passkeyNotFound';
        case 'ORGANIZATION_CONTENT_CLEANUP_REQUIRED':
            return 'cleanupRequired';
        default:
            return 'generic';
    }
}

/** Query errors retain only a local translation key, never a native error payload. */
export class SecurityRequestError extends Error {
    constructor(readonly key: SecurityErrorKey) {
        super('ACCOUNT_SECURITY_REQUEST_FAILED');
        this.name = 'SecurityRequestError';
    }
}
