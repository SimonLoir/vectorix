import { APIError, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { isCanonicalUserLocale } from './user-locale-fields';

type Context = Parameters<typeof getAuthoritativeSessionFromCtx>[0];

/**
 * Locale writes use the native current-user endpoint and an authoritative cookie
 * session, including when a stale cookie cache exists. Signup does not accept a
 * client-assigned saved preference. No organization/API-key authority is used.
 */
export async function requireUserLocaleSession(ctx: Context): Promise<void> {
    if (!ctx.body || !Object.prototype.hasOwnProperty.call(ctx.body, 'locale'))
        return;
    if (ctx.path === '/sign-up/email') {
        throw new APIError('BAD_REQUEST', {
            code: 'USER_LOCALE_UPDATE_REQUIRED',
            message: 'Sign in before saving an account language.',
        });
    }
    if (ctx.path !== '/update-user') return;
    const session = await getAuthoritativeSessionFromCtx(ctx);
    if (!session) {
        throw new APIError('UNAUTHORIZED', {
            code: 'USER_LOCALE_SESSION_REQUIRED',
            message: 'Sign in before saving an account language.',
        });
    }
    const locale: unknown = Object.getOwnPropertyDescriptor(
        ctx.body,
        'locale'
    )?.value;
    if (!isCanonicalUserLocale(locale)) {
        throw new APIError('BAD_REQUEST', {
            code: 'USER_LOCALE_INVALID',
            message: 'Choose a supported account language.',
        });
    }
}
