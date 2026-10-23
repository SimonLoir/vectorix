import {
    createEmailVerificationToken,
    getAuthoritativeSessionFromCtx,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { parseUserOutput } from 'better-auth/db';
import {
    assertEmailOwnershipConfigured,
    emailOwnershipReturnTo,
    emailOwnershipSecret,
} from './configuration';
import { emailOwnershipError } from './errors';
import { readEmailOwnershipToken } from './tokens';
import { applyEmailOwnershipProof } from './persistence';
import { sendEmailOwnershipMessage } from './messages';

type Context = Parameters<typeof getAuthoritativeSessionFromCtx>[0];
function field(value: unknown, key: string): unknown {
    if (!value || typeof value !== 'object') return undefined;
    const result: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
    return result;
}

function normalizedNativeRequest(body: unknown, email: string, path: string) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw emailOwnershipError('EMAIL_VERIFICATION_EMAIL_MISMATCH');
    }
    const callbackURL = emailOwnershipReturnTo(field(body, 'callbackURL'));
    if (path === '/send-verification-email') {
        const requestedEmail = field(body, 'email');
        if (
            typeof requestedEmail !== 'string' ||
            requestedEmail.toLowerCase() !== email.toLowerCase()
        ) {
            throw emailOwnershipError('EMAIL_VERIFICATION_EMAIL_MISMATCH');
        }
    }
    return { ...body, callbackURL };
}

/**
 * Handle the native verification path before its email-based mutation and
 * unauthenticated session-creation branches. Other auth operations continue
 * through the normal framework pipeline; existing login is not gated by mail.
 */
export async function handleEmailOwnership(ctx: Context) {
    if (
        ![
            '/verify-email',
            '/send-verification-email',
            '/change-email',
        ].includes(ctx.path)
    )
        return;
    const session = await getAuthoritativeSessionFromCtx(ctx);
    if (!session)
        throw emailOwnershipError('EMAIL_VERIFICATION_SESSION_REQUIRED');
    if (ctx.path === '/change-email' && session.user.emailVerified !== true) {
        throw emailOwnershipError(
            'EMAIL_VERIFICATION_CURRENT_ADDRESS_REQUIRED'
        );
    }
    assertEmailOwnershipConfigured();
    const secret = emailOwnershipSecret();
    if (ctx.context.secret !== secret)
        throw emailOwnershipError('EMAIL_VERIFICATION_UNAVAILABLE');
    ctx.setHeader('cache-control', 'no-store');
    ctx.setHeader('referrer-policy', 'no-referrer');
    if (ctx.path !== '/verify-email') {
        // Before hooks receive a shallow context copy. Return the replacement
        // explicitly so native mail code cannot substitute its default `/`.
        return {
            context: {
                body: normalizedNativeRequest(
                    ctx.body,
                    session.user.email,
                    ctx.path
                ),
            },
        };
    }
    const claims = await readEmailOwnershipToken(
        field(ctx.query, 'token'),
        secret
    );
    if (claims.userId !== session.user.id)
        throw emailOwnershipError('EMAIL_VERIFICATION_ACCOUNT_MISMATCH');
    if (claims.email !== session.user.email.toLowerCase())
        throw emailOwnershipError('EMAIL_VERIFICATION_STALE');
    if (field(ctx.query, 'callbackURL') !== undefined)
        emailOwnershipReturnTo(field(ctx.query, 'callbackURL'));
    const confirming = claims.requestType === 'change-email-confirmation';
    const user = await applyEmailOwnershipProof({
        claims,
        sessionId: session.session.id,
        confirmationOnly: confirming,
    });
    if (confirming) {
        const remaining = claims.exp - Math.ceil(Date.now() / 1000) - 1;
        if (remaining <= 0)
            throw emailOwnershipError('EMAIL_VERIFICATION_INVALID_TOKEN');
        const nextClaims = {
            ...claims,
            requestType: 'change-email-verification' as const,
        };
        const token = await createEmailVerificationToken(
            secret,
            claims.email,
            claims.updateTo,
            remaining,
            {
                requestType: nextClaims.requestType,
                userId: claims.userId,
                vectorixEmailOwnership: 1,
                returnTo: claims.returnTo,
            }
        );
        await sendEmailOwnershipMessage({
            token,
            claims: nextClaims,
            savedLocale: user.locale,
            request: ctx.request,
        });
        return ctx.json({
            status: true,
            outcome: 'NEW_ADDRESS_VERIFICATION_REQUIRED',
        });
    }
    await setSessionCookie(ctx, { session: session.session, user });
    return ctx.json({
        status: true,
        outcome: claims.updateTo ? 'ADDRESS_CHANGED' : 'ADDRESS_VERIFIED',
        user: parseUserOutput(ctx.context.options, user),
    });
}
