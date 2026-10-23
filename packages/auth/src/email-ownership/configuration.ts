import { assertSystemMailConfigured } from '@repo/emails';
import { buildCanonicalPasswordResetUrl } from '../password-reset-url';
import { emailOwnershipError } from './errors';

const accountReturn = '/dashboard/account';
const invitationPath = '/dashboard/accept-invitation';

function hasControls(value: string, rejectSpace = false): boolean {
    for (const character of value) {
        const code = character.codePointAt(0);
        if (
            code === undefined ||
            code <= (rejectSpace ? 0x20 : 0x1f) ||
            code === 0x7f
        )
            return true;
    }
    return false;
}

/** Only two application-owned destinations may survive a mail/sign-in round trip. */
export function emailOwnershipReturnTo(value?: unknown): string {
    if (value === undefined) return accountReturn;
    if (
        typeof value !== 'string' ||
        value.length > 1024 ||
        value.includes('\\') ||
        hasControls(value, true)
    ) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_CALLBACK');
    }
    const base = 'https://vectorix.invalid';
    let url: URL;
    try {
        url = new URL(value, base);
    } catch {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_CALLBACK');
    }
    if (url.origin !== base || !value.startsWith('/') || url.hash) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_CALLBACK');
    }
    if (url.pathname === accountReturn && !url.search) return accountReturn;
    const id = url.searchParams.get('id');
    if (
        url.pathname !== invitationPath ||
        [...url.searchParams.keys()].length !== 1 ||
        !id ||
        id.length > 128 ||
        hasControls(id)
    ) {
        throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_CALLBACK');
    }
    return `${invitationPath}?id=${encodeURIComponent(id)}`;
}

/** Reuse the established canonical web URL precedence/path-prefix validation. */
export function emailOwnershipWebUrl(token: string, returnTo: string): string {
    try {
        const url = new URL(buildCanonicalPasswordResetUrl(token));
        url.pathname = url.pathname.replace(/reset-password$/u, 'verify-email');
        url.searchParams.set('returnTo', emailOwnershipReturnTo(returnTo));
        return url.href;
    } catch {
        throw emailOwnershipError('EMAIL_VERIFICATION_UNAVAILABLE');
    }
}

/** A stable configured signing key and mail destination are required for these actions, not general login. */
export function emailOwnershipSecret(): string {
    const value = process.env.BETTER_AUTH_SECRET;
    if (!value || value.length < 32 || hasControls(value)) {
        throw emailOwnershipError('EMAIL_VERIFICATION_UNAVAILABLE');
    }
    return value;
}

/** Fail before native account lookup/token work; callbacks independently repeat this check. */
export function assertEmailOwnershipConfigured(): void {
    try {
        emailOwnershipSecret();
        emailOwnershipWebUrl('', accountReturn);
        assertSystemMailConfigured();
    } catch {
        throw emailOwnershipError('EMAIL_VERIFICATION_UNAVAILABLE');
    }
}
