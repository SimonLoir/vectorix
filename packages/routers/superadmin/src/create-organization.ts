import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';

export const createOrganization = superAdminV1.organizations.create.handler(
    async ({ context: { db, headers, user }, input }) => {
        const existing = await db.organization.findUnique({
            where: { slug: input.slug },
            select: { id: true },
        });
        if (existing) {
            throw new ORPCError('CONFLICT', {
                message: 'Ce slug est déjà utilisé par une autre organisation.',
            });
        }

        const organization = await db.organization.create({
            data: {
                id: randomUUID(),
                name: input.name,
                slug: input.slug,
                isActive: input.isActive,
                createdAt: new Date(),
            },
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
            db,
            headers,
            userId: user.id,
            action: 'organization.create',
            targetId: organization.id,
            details: { name: organization.name, slug: organization.slug },
        });

        return organization;
    }
);
