import { ORPCError } from '@orpc/server';
import { adminOrganizationsV1 } from './v1-implementer';
export const getOrganization = adminOrganizationsV1.get.handler(
    async ({ context: { db, organizationId } }) => {
        const organization = await db.organization.findUnique({
            where: { id: organizationId },
            select: { id: true, name: true, slug: true, logo: true },
        });
        if (!organization) throw new ORPCError('NOT_FOUND');
        return organization;
    }
);
