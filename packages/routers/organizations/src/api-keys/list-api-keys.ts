import { ORPCError } from '@orpc/server';
import type { PermissionSet } from '@repo/auth/permissions';
import { adminOrganizationsV1 } from '../v1-implementer';

/** Lists only safe key metadata for a session-authenticated organization member. */
export const listScopedApiKeys = adminOrganizationsV1.apiKeys.list.handler(
    async ({ context }) => {
        if (!context.user) throw new ORPCError('FORBIDDEN');
        const keys = await context.db.apikey.findMany({
            where: { configId: 'org', referenceId: context.organizationId },
            select: {
                id: true,
                name: true,
                createdAt: true,
                expiresAt: true,
                enabled: true,
                permissions: true,
                vectorixLegacyFullAccess: true,
            },
            orderBy: { createdAt: 'desc' },
        });
        return {
            keys: keys.map(
                ({
                    vectorixLegacyFullAccess,
                    permissions,
                    enabled,
                    ...key
                }) => ({
                    ...key,
                    enabled: enabled ?? true,
                    legacyFullAccess: vectorixLegacyFullAccess,
                    permissions: permissions
                        ? (JSON.parse(permissions) as PermissionSet)
                        : {},
                })
            ),
        };
    }
);
