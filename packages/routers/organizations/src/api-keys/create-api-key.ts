import { auth } from '@repo/auth';
import { ORPCError } from '@orpc/server';
import { adminOrganizationsV1 } from '../v1-implementer';
import { scopedKeyPermissions } from './scoped-permissions';

/** Uses the native Better Auth generator, hashing and key storage after scoped delegation checks. */
export const createScopedApiKey = adminOrganizationsV1.apiKeys.create.handler(
    async ({ context, input }) => {
        const permissions = await scopedKeyPermissions(
            context,
            input.permissions
        );
        if (!context.user) throw new ORPCError('FORBIDDEN');
        const key = await auth.api.createApiKey({
            body: {
                configId: 'org',
                organizationId: context.organizationId,
                userId: context.user.id,
                name: input.name,
                permissions,
            },
        });
        return { id: key.id, key: key.key };
    }
);
