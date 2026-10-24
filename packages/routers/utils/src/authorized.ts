import { auth } from '@repo/auth';
import { base } from './base';
import { onError, ORPCError } from '@orpc/server';
import type { Logger } from 'pino';
import type { ApiContext } from './base';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import type { PermissionSet } from '@repo/auth/permissions';
import { requireOperationPermissions, requirePermissions } from './permissions';
import { compoundPermissions } from '@repo/auth/permissions/compound-actions';
import {
    requireExpectedOrganization,
    resolveExpectedOrganizationAccess,
} from './expected-organization';
import { resolveCurrentApiKeyAccess } from './api-key-access';
import { normalizeAuthorizationError } from './authorization-error';
import {
    createProviderRateLimitAdmission,
    enforceApiRateLimit,
    parseApiRateLimits,
    PROVIDER_OPERATIONS,
} from './api-rate-limit';

const apiRateLimits = parseApiRateLimits(process.env);

const authorize = async (
    headers: Headers,
    logger: Logger,
    db: ApiContext['db']
) => {
    const apiKey = headers.get('x-api-key');
    if (apiKey) {
        const result = await auth.api.verifyApiKey({
            body: {
                key: apiKey,
                configId: 'org',
            },
        });

        if (!result.valid || result.error || !result.key) {
            logger.warn(
                { authMethod: 'api-key' },
                'API key authentication rejected'
            );
            throw new ORPCError('INVALID_API_KEY', { status: 401 });
        }

        requireExpectedOrganization(headers, result.key.referenceId);

        const permissions = await resolveCurrentApiKeyAccess(db, {
            keyId: result.key.id,
            organizationId: result.key.referenceId,
        });

        logger.debug(
            {
                authMethod: 'api-key',
                actorId: result.key.id,
                organizationId: result.key.referenceId,
            },
            'API key authentication succeeded'
        );

        return {
            key: result.key,
            session: null,
            user: null,
            organizationId: result.key.referenceId,
            permissions,
            legacyApiKey: false,
        } as const;
    }

    const sessionData = await auth.api.getSession({
        headers,
    });

    if (
        !sessionData?.session ||
        !sessionData?.user ||
        !sessionData?.session.activeOrganizationId
    ) {
        logger.warn(
            {
                authMethod: 'session',
                hasAuthorizationHeader: headers.has('authorization'),
                hasCookieHeader: headers.has('cookie'),
            },
            'Session authentication rejected'
        );
        throw new ORPCError('UNAUTHORIZED');
    }

    const { organizationId, access } = await resolveExpectedOrganizationAccess(
        headers,
        sessionData.session.activeOrganizationId,
        sessionData.user.id,
        (organizationId, userId) =>
            getMemberPermissions(organizationId, userId, db)
    );

    logger.debug(
        {
            authMethod: 'session',
            actorId: sessionData.user.id,
            organizationId,
        },
        'Session authentication succeeded'
    );

    return {
        session: sessionData.session,
        user: sessionData.user,
        key: null,
        organizationId,
        permissions: access.permissions,
        legacyApiKey: false,
    } as const;
};

type AuthorizationResult = Awaited<ReturnType<typeof authorize>>;

export type AuthorizedContext = ApiContext & {
    key: AuthorizationResult['key'];
    session: AuthorizationResult['session'];
    user: AuthorizationResult['user'];
    organizationId: string;
    permissions: PermissionSet;
    legacyApiKey: boolean;
    /** HTTP request admission after real resource/binding authorization, before provider work. */
    admitProviderRequest?: () => Promise<void>;
};

export const authMiddleware = base.middleware(
    async ({ context, next, path }, input) => {
        const access = await authorize(
            context.headers,
            context.logger,
            context.db
        );
        const organization = await context.db.organization.findUnique({
            where: { id: access.organizationId },
            select: { isActive: true },
        });
        if (!organization?.isActive)
            throw new ORPCError('FORBIDDEN', {
                message: 'Organization is inactive.',
            });
        // Count authenticated callers before permission checks so denied loops are throttled too.
        const principal = {
            organizationId: access.organizationId,
            keyId: access.key?.id ?? null,
            userId: access.user?.id ?? null,
        };
        await enforceApiRateLimit(principal, apiRateLimits, context.resHeaders);
        requireOperationPermissions(access, path);
        requirePermissions(access, compoundPermissions(path.join('.'), input));
        return next({
            context: {
                ...access,
                admitProviderRequest: PROVIDER_OPERATIONS.has(path.join('.'))
                    ? createProviderRateLimitAdmission(
                          principal,
                          apiRateLimits,
                          context.resHeaders
                      )
                    : undefined,
            },
        });
    }
);

export const authorized = base
    .use(
        onError((error) => {
            // Installed onError rethrows its input unless this callback throws.
            throw normalizeAuthorizationError(error);
        })
    )
    .use(authMiddleware);
