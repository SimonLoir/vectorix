import { auth } from '@repo/auth'; // Your Better Auth instance
import { base } from './base';
import { onError, ORPCError } from '@orpc/server';
import type { Logger } from 'pino';
import type { ApiContext } from './base';
import { prisma } from '@repo/db';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import type { PermissionSet } from '@repo/auth/permissions';
import { requireOperationPermissions, requirePermissions } from './permissions';
import { compoundPermissions } from '@repo/auth/permissions/compound-actions';
import {
    requireExpectedOrganization,
    resolveExpectedOrganizationAccess,
} from './expected-organization';

const authorize = async (headers: Headers, logger: Logger) => {
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
            throw new ORPCError('INVALID_API_KEY');
        }

        requireExpectedOrganization(headers, result.key.referenceId);

        const storedKey = await prisma.apikey.findUnique({
            where: { id: result.key.id },
        });
        if (
            !storedKey ||
            storedKey.configId !== 'org' ||
            storedKey.referenceId !== result.key.referenceId
        )
            throw new ORPCError('INVALID_API_KEY');

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
            permissions:
                !storedKey.vectorixLegacyFullAccess && storedKey.permissions
                    ? (JSON.parse(storedKey.permissions) as PermissionSet)
                    : {},
            legacyApiKey: storedKey.vectorixLegacyFullAccess,
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
        getMemberPermissions
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
};

export const authMiddleware = base.middleware(
    async ({ context, next, path }, input) => {
        const access = await authorize(context.headers, context.logger);
        const organization = await context.db.organization.findUnique({
            where: { id: access.organizationId },
            select: { isActive: true },
        });
        if (!organization?.isActive)
            throw new ORPCError('FORBIDDEN', {
                message: 'Organization is inactive.',
            });
        requireOperationPermissions(access, path);
        requirePermissions(access, compoundPermissions(path.join('.'), input));
        return next({
            context: access,
        });
    }
);

export const authorized = base
    .use(
        onError((e) => {
            if (e instanceof ORPCError) throw e;
            if (
                'status' in e &&
                typeof e.status === 'string' &&
                e.status === 'UNAUTHORIZED'
            )
                throw new ORPCError('UNAUTHORIZED');
            console.error(e);
        })
    )
    .use(authMiddleware);
