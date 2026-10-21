import type { Prisma } from '@repo/db';
import { superAdminV1 } from './v1-implementer';

export const listOrganizations = superAdminV1.organizations.list.handler(
    async ({ context: { db }, input }) => {
        const search = input.search?.trim();
        const where = {
            ...(search
                ? {
                      OR: [
                          {
                              name: {
                                  contains: search,
                                  mode: 'insensitive' as const,
                              },
                          },
                          {
                              slug: {
                                  contains: search,
                                  mode: 'insensitive' as const,
                              },
                          },
                      ],
                  }
                : {}),
            ...(input.status === 'active'
                ? { isActive: true }
                : input.status === 'inactive'
                  ? { isActive: false }
                  : {}),
        } satisfies Prisma.OrganizationWhereInput;

        const [organizations, total] = await Promise.all([
            db.organization.findMany({
                where,
                select: {
                    id: true,
                    name: true,
                    slug: true,
                    logo: true,
                    isActive: true,
                    vectorixLegacyAccess: true,
                    createdAt: true,
                    _count: {
                        select: {
                            members: true,
                            vectorixFeatureOverrides: true,
                        },
                    },
                },
                orderBy: { createdAt: 'desc' },
                skip: (input.page - 1) * input.limit,
                take: input.limit,
            }),
            db.organization.count({ where }),
        ]);

        return { organizations, total };
    }
);
