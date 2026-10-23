/** Public, browser-safe boundaries for email ownership and sign-in resumption. */
export const EMAIL_VERIFICATION_TOKEN_LIMIT = 8192;

export type EmailVerificationOutcome =
    | 'ADDRESS_VERIFIED'
    | 'ADDRESS_CHANGED'
    | 'NEW_ADDRESS_VERIFICATION_REQUIRED';

export type EmailOwnershipErrorKey =
    | 'generic'
    | 'unavailable'
    | 'sessionRequired'
    | 'accountMismatch'
    | 'invalidToken'
    | 'stale'
    | 'emailMismatch'
    | 'currentAddressRequired'
    | 'verificationRequired'
    | 'invitationRecipient';

function hasUnsafeInvitationCharacter(value: string): boolean {
    for (const character of value) {
        const point = character.codePointAt(0);
        if (
            point === undefined ||
            point <= 0x1f ||
            point === 0x7f ||
            (point >= 0xd8_00 && point <= 0xdf_ff)
        )
            return true;
    }
    return false;
}

function hasUnsafeCallbackCharacter(value: string): boolean {
    if (value.includes('\\') || value.includes('#')) return true;
    for (const character of value) {
        const point = character.codePointAt(0);
        if (point === undefined || point <= 0x20 || point === 0x7f) return true;
    }
    return false;
}

/** Invitation identifiers stay opaque and are encoded only when building a URL. */
export function isInvitationId(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 128 &&
        !hasUnsafeInvitationCharacter(value)
    );
}

export function invitationReviewPath(id: string): string | null {
    return isInvitationId(id)
        ? `/dashboard/accept-invitation?id=${encodeURIComponent(id)}`
        : null;
}

/** Accept only the relative destinations supported by the email service. */
export function emailOwnershipCallback(value: unknown): string | null {
    if (value === '/dashboard/account') return value;
    const prefix = '/dashboard/accept-invitation?';
    if (
        typeof value !== 'string' ||
        value.length > 1024 ||
        !value.startsWith(prefix) ||
        hasUnsafeCallbackCharacter(value)
    )
        return null;
    const query = new URLSearchParams(value.slice(prefix.length));
    const id = query.get('id');
    return query.size === 1 && id && isInvitationId(id)
        ? invitationReviewPath(id)
        : null;
}

export function isEmailVerificationToken(value: unknown): value is string {
    return (
        typeof value === 'string' &&
        value.length >= 16 &&
        value.length <= EMAIL_VERIFICATION_TOKEN_LIMIT &&
        /^[A-Za-z0-9._~-]+$/u.test(value)
    );
}

/** Build a local resume URL without exposing the token in rendered content. */
export function emailVerificationPath(
    token: string,
    returnTo: string
): string | null {
    const callback = emailOwnershipCallback(returnTo);
    if (!isEmailVerificationToken(token) || !callback) return null;
    return `/verify-email?${new URLSearchParams({ token, returnTo: callback })}`;
}

/** Never forward a caller-controlled redirect to the sign-in form or router. */
export function emailOwnershipSignInReturn(value: unknown): string {
    const callback = emailOwnershipCallback(value);
    if (callback) return callback;
    if (
        typeof value !== 'string' ||
        value.length > 12_500 ||
        !value.startsWith('/verify-email?')
    )
        return '/dashboard';
    const query = new URLSearchParams(value.slice('/verify-email?'.length));
    if (
        query.size !== 2 ||
        query.getAll('token').length !== 1 ||
        query.getAll('returnTo').length !== 1
    )
        return '/dashboard';
    const token = query.get('token');
    const returnTo = emailOwnershipCallback(query.get('returnTo'));
    return token && returnTo
        ? (emailVerificationPath(token, returnTo) ?? '/dashboard')
        : '/dashboard';
}

/** The native client cannot infer the server's compatible extra outcome field. */
export function emailVerificationOutcome(
    value: unknown
): EmailVerificationOutcome | null {
    if (
        typeof value !== 'object' ||
        value === null ||
        !('status' in value) ||
        value.status !== true ||
        !('outcome' in value)
    )
        return null;
    switch (value.outcome) {
        case 'ADDRESS_VERIFIED':
        case 'ADDRESS_CHANGED':
        case 'NEW_ADDRESS_VERIFICATION_REQUIRED':
            return value.outcome;
        default:
            return null;
    }
}

export function requiresInvitationVerification(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || !('code' in value))
        return false;
    return (
        value.code === 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION' ||
        value.code ===
            'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION'
    );
}

/** Map finite codes only. Server messages, tokens and response bodies stay private. */
export function emailOwnershipError(value: unknown): EmailOwnershipErrorKey {
    if (typeof value !== 'object' || value === null || !('code' in value))
        return 'generic';
    switch (value.code) {
        case 'EMAIL_VERIFICATION_UNAVAILABLE':
            return 'unavailable';
        case 'EMAIL_VERIFICATION_SESSION_REQUIRED':
            return 'sessionRequired';
        case 'EMAIL_VERIFICATION_ACCOUNT_MISMATCH':
            return 'accountMismatch';
        case 'EMAIL_VERIFICATION_INVALID_TOKEN':
            return 'invalidToken';
        case 'EMAIL_VERIFICATION_STALE':
            return 'stale';
        case 'EMAIL_VERIFICATION_EMAIL_MISMATCH':
            return 'emailMismatch';
        case 'EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED':
            return 'currentAddressRequired';
        case 'EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION':
        case 'EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION':
            return 'verificationRequired';
        case 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION':
            return 'invitationRecipient';
        default:
            return 'generic';
    }
}
