import { ORPCError } from '@orpc/server';
import { permits } from '@repo/auth/permissions';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import { adminOrganizationsV1 } from './v1-implementer';

/** Returns live member permissions; API keys cannot impersonate a dashboard member. */
export const getOrganizationAccess = adminOrganizationsV1.access.handler(
    async ({ context }) => {
        if (!context.user) throw new ORPCError('FORBIDDEN');
        const access = await getMemberPermissions(
            context.organizationId,
            context.user.id
        );
        if (!access) throw new ORPCError('UNAUTHORIZED');
        const canReadRoles = permits(access.permissions, { ac: ['read'] });
        const roles = access.definitions.map((definition) => ({
            ...definition,
            assignable: permits(access.permissions, definition.permissions),
        }));
        return {
            memberId: access.member.id,
            role: access.member.role,
            permissions: access.permissions,
            roles: roles.filter((role) => canReadRoles || role.assignable),
        };
    }
);
