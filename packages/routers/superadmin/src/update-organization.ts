import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';
import { runSuperAdminTransaction } from './superadmin-transaction';

export const updateOrganization = superAdminV1.organizations.update.handler(
    ({ context: { db, headers, user }, input }) =>
        runSuperAdminTransaction(db, user.id, async (tx) => {
            const existing = await tx.organization.findUnique({
                where: { id: input.organizationId },
            });
            if (!existing) {
                throw new ORPCError('NOT_FOUND', {
                    message: 'Organization not found',
                });
            }

            const data: Prisma.OrganizationUpdateInput = {};
            if (input.name !== undefined) data.name = input.name;
            if (input.slug !== undefined) data.slug = input.slug;
            if (input.logo !== undefined) data.logo = input.logo;
            if (input.isActive !== undefined) data.isActive = input.isActive;
            if (input.metadata !== undefined) data.metadata = input.metadata;

            const organization = await tx.organization.update({
                where: { id: input.organizationId },
                data,
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    logo: true,
                    isActive: true,
                    vectorixLegacyAccess: true,
                    metadata: true,
                    createdAt: true,
                },
            });

            await auditSuperAdminAction({
                db: tx,
                headers,
                userId: user.id,
                action: 'organization.update',
                targetId: organization.id,
                details: {
                    before: {
                        name: existing.name,
                        slug: existing.slug,
                        isActive: existing.isActive,
                    },
                    after: {
                        name: organization.name,
                        slug: organization.slug,
                        isActive: organization.isActive,
                    },
                },
            });

            return organization;
        })
);
