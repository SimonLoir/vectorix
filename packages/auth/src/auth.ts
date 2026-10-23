import { betterAuth } from 'better-auth';
import type { BetterAuthAdvancedOptions } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, organization } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { prisma } from '@repo/db';
import { apiKey } from '@better-auth/api-key';
import { sendPasswordResetEmail } from './password-reset-email';
import { userLocaleFields } from './user-locale-fields';
import { requireUserLocaleSession } from './user-locale';
import { assertSystemMailConfigured } from '@repo/emails';
import { assertPasswordResetUrlConfigured } from './password-reset-url';
import { handleEmailOwnership } from './email-ownership/handler';
import { sendEmailOwnershipVerification } from './email-ownership/mail';
import { authRateLimitOptions } from './rate-limit';
import { isAccountCreationAllowed } from './account-creation';
import { isOrganizationCreationAllowed } from './organization-creation';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { accessControl, roles } from './permissions/access-control';
import {
    apiKeyPolicyHook,
    clearRemovedMemberSessions,
} from './permissions/key-hooks';
import { organizationPolicyHook } from './permissions/organization-hooks';
import { requireOrganizationCleanup } from './permissions/organization-deletion';
import {
    organizationReadPolicyHook,
    organizationReadResultHook,
} from './permissions/organization-read-hooks';
import { notifySessionCreated } from './session-created';
import { getPasskeyOptions } from './passkey-options';
import { createTwoFactorPlugin } from './two-factor';
import {
    isChallengeableSignIn,
    signInNotificationPlugin,
} from './sign-in-notification-plugin';

const getEnvValue = (key: string) => {
    const value = process.env[key]?.trim();
    return value && value.length > 0 ? value : undefined;
};

const getAdvancedOptions = (): BetterAuthAdvancedOptions | undefined => {
    const rootDomain = getEnvValue('ROOT_DOMAIN');
    const cookieName = getEnvValue('BETTER_AUTH_COOKIE_NAME');
    const cookiePrefix = getEnvValue('BETTER_AUTH_COOKIE_PREFIX');

    const advanced: BetterAuthAdvancedOptions = {};

    if (rootDomain) {
        advanced.crossSubDomainCookies = {
            enabled: true,
            domain: rootDomain,
        };
    }

    if (cookiePrefix) {
        advanced.cookiePrefix = cookiePrefix;
    }

    if (cookieName) {
        advanced.cookies = {
            ['session_token']: {
                name: cookieName,
            },
        };
    }

    return Object.keys(advanced).length > 0 ? advanced : undefined;
};

export const auth = betterAuth({
    hooks: {
        before: createAuthMiddleware(async (ctx) => {
            await requireUserLocaleSession(ctx);
            // Better Auth swallows mail callback errors after creating a token.
            // Validate first so known and unknown accounts receive the same 503.
            if (ctx.path === '/request-password-reset') {
                assertPasswordResetUrlConfigured();
                try {
                    assertSystemMailConfigured();
                } catch {
                    throw new APIError('SERVICE_UNAVAILABLE', {
                        code: 'PASSWORD_RESET_UNAVAILABLE',
                        message: 'Password reset is temporarily unavailable.',
                    });
                }
            }
            const emailResponse = await handleEmailOwnership(ctx);
            if (emailResponse) return emailResponse;
            if (
                ctx.path === '/update-user' &&
                ctx.body &&
                Object.prototype.hasOwnProperty.call(ctx.body, 'image')
            ) {
                throw new APIError('BAD_REQUEST', {
                    message: 'Profile image updates are not enabled.',
                });
            }
            await apiKeyPolicyHook(ctx);
            await organizationPolicyHook(ctx);
            await organizationReadPolicyHook(ctx);
        }),
        after: organizationReadResultHook,
    },
    advanced: getAdvancedOptions(),
    rateLimit: authRateLimitOptions,
    trustedOrigins: process.env.TRUSTED_ORIGINS
        ? process.env.TRUSTED_ORIGINS.split(',')
              .map((origin) => origin.trim())
              .filter((origin) => origin.length > 0)
        : undefined,
    database: prismaAdapter(prisma, {
        provider: 'postgresql',
        transaction: true,
    }),
    emailAndPassword: {
        enabled: true,
        disableSignUp: !isAccountCreationAllowed(),
        sendResetPassword: ({ user, token }, request) =>
            sendPasswordResetEmail({ user, token, request }),
        revokeSessionsOnPasswordReset: true,
    },
    emailVerification: {
        autoSignInAfterVerification: false,
        expiresIn: 3600,
        sendOnSignUp: false,
        sendOnSignIn: false,
        sendVerificationEmail: (input, request) =>
            sendEmailOwnershipVerification(input, request),
    },
    plugins: [
        bearer(),
        apiKey([
            {
                configId: 'org',
                defaultPrefix: 'org_',
                references: 'organization',
                rateLimit: {
                    enabled: false,
                },
            },
        ]),
        organization({
            ac: accessControl,
            roles,
            dynamicAccessControl: { enabled: true },
            requireEmailVerificationOnInvitation: true,
            organizationHooks: {
                beforeDeleteOrganization: ({ organization }) =>
                    requireOrganizationCleanup(prisma, organization.id),
                afterRemoveMember: ({ member }) =>
                    clearRemovedMemberSessions(member),
            },
            allowUserToCreateOrganization: isOrganizationCreationAllowed(),
        }),
        passkey(getPasskeyOptions()),
        createTwoFactorPlugin(),
        // Must follow twoFactor so a pending challenge is not notified.
        signInNotificationPlugin(),
    ],

    user: {
        additionalFields: userLocaleFields,
        changeEmail: {
            enabled: true,
            updateEmailWithoutVerification: false,
            sendChangeEmailConfirmation: (input, request) =>
                sendEmailOwnershipVerification(input, request),
        },
        deleteUser: {
            enabled: true,
        },
    },

    databaseHooks: {
        session: {
            create: {
                before: async (session) => {
                    const organization = await prisma.organization.findFirst({
                        where: {
                            members: {
                                some: {
                                    userId: session.userId,
                                },
                            },
                        },
                    });
                    return {
                        data: {
                            ...session,
                            ...(organization && {
                                activeOrganizationId: organization.id,
                            }),
                        },
                    };
                },
                after: (session, context) => {
                    // Credential sign-ins notify from signInNotificationPlugin,
                    // once a possible 2FA challenge has deleted the session.
                    if (isChallengeableSignIn(context?.path)) {
                        return Promise.resolve();
                    }
                    // Never delay or fail sign-in on notification bookkeeping.
                    void notifySessionCreated(session);
                    return Promise.resolve();
                },
            },
        },
    },
});
