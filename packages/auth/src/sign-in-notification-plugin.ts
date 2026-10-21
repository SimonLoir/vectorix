import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { notifySessionCreated } from './session-created';

/** Credential sign-ins that the two-factor plugin may turn into a challenge. */
export const CHALLENGEABLE_SIGN_IN_PATHS: ReadonlySet<string> = new Set([
    '/sign-in/email',
]);

/**
 * Whether the session-created database hook must leave notification to the
 * after-hook below, because the two-factor plugin may still delete the
 * session it just created.
 */
export function isChallengeableSignIn(path: string | undefined) {
    return path !== undefined && CHALLENGEABLE_SIGN_IN_PATHS.has(path);
}

/**
 * Notifies sign-in listeners for credential sign-ins once every plugin
 * after-hook has run. It must be registered after `twoFactor`: when a 2FA
 * challenge is pending `newSession` is reset to null and nothing is sent; the
 * verified session created by `/two-factor/verify-*` goes through the regular
 * database hook instead. Listener failures never affect the response.
 */
export function signInNotificationPlugin() {
    return {
        id: 'vectorix-sign-in-notification',
        hooks: {
            after: [
                {
                    matcher: (context) => isChallengeableSignIn(context.path),
                    handler: createAuthMiddleware((ctx) => {
                        const session = ctx.context.newSession?.session;
                        if (session) void notifySessionCreated(session);
                        return Promise.resolve();
                    }),
                },
            ],
        },
    } satisfies BetterAuthPlugin;
}
