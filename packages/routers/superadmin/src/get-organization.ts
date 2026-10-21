import { ORPCError } from '@orpc/server';
import { superAdminV1 } from './v1-implementer';

export const getOrganization = superAdminV1.organizations.get.handler(
    async ({ context: { db }, input }) => {
        const organization = await db.organization.findUnique({
            where: { id: input.organizationId },
            select: {
                id: true,
                name: true,
                slug: true,
                logo: true,
                isActive: true,
                vectorixLegacyAccess: true,
                metadata: true,
                createdAt: true,
                members: {
                    select: {
                        id: true,
                        role: true,
                        createdAt: true,
                        user: {
                            select: {
                                id: true,
                                name: true,
                                email: true,
                                image: true,
                                emailVerified: true,
                            },
                        },
                    },
                    orderBy: { createdAt: 'asc' },
                },
                _count: {
                    select: {
                        vectorixFeatureOverrides: true,
                    },
                },
            },
        });

        if (!organization) {
            throw new ORPCError('NOT_FOUND', {
                message: 'Organization not found',
            });
        }

        return organization;
    }
);
