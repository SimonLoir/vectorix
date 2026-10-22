import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';
import { runSuperAdminTransaction } from './superadmin-transaction';

export const createOrganization = superAdminV1.organizations.create.handler(
    ({ context: { db, headers, user }, input }) =>
        runSuperAdminTransaction(db, user.id, async (tx) => {
            const existing = await tx.organization.findUnique({
                where: { slug: input.slug },
                select: { id: true },
            });
            if (existing) {
                throw new ORPCError('CONFLICT', {
                    message:
                        'Ce slug est déjà utilisé par une autre organisation.',
                });
            }

            const organization = await tx.organization.create({
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
                db: tx,
                headers,
                userId: user.id,
                action: 'organization.create',
                targetId: organization.id,
                details: { name: organization.name, slug: organization.slug },
            });

            return organization;
        })
);
