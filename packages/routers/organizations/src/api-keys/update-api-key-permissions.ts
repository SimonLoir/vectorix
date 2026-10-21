import { ORPCError } from '@orpc/server';
import { adminOrganizationsV1 } from '../v1-implementer';
import { scopedKeyPermissions } from './scoped-permissions';

/** Atomically updates native permissions and irreversibly removes grandfathered full access. */
export const updateScopedApiKeyPermissions =
    adminOrganizationsV1.apiKeys.updatePermissions.handler(
        async ({ context, input }) => {
            const permissions = await scopedKeyPermissions(
                context,
                input.permissions
            );
            const result = await context.db.apikey.updateMany({
                where: {
                    id: input.keyId,
                    configId: 'org',
                    referenceId: context.organizationId,
                },
                data: {
                    permissions: JSON.stringify(permissions),
                    vectorixLegacyFullAccess: false,
                    updatedAt: new Date(),
                },
            });
            if (!result.count) throw new ORPCError('NOT_FOUND');
            return { success: true };
        }
    );
