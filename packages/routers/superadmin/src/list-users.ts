import type { Prisma } from '@repo/db';
import { superAdminUserSelect } from './user-select';
import { superAdminV1 } from './v1-implementer';

/** Searches existing global Vectorix accounts with bounded pages and stable ordering. */
export const listSuperAdminUsers = superAdminV1.users.list.handler(
    async ({ context: { db }, input }) => {
        const where = {
            ...(input.search
                ? {
                      OR: [
                          {
                              name: {
                                  contains: input.search,
                                  mode: 'insensitive' as const,
                              },
                          },
                          {
                              email: {
                                  contains: input.search,
                                  mode: 'insensitive' as const,
                              },
                          },
                      ],
                  }
                : {}),
            ...(input.access
                ? { isSuperAdmin: input.access === 'superadmin' }
                : {}),
        } satisfies Prisma.UserWhereInput;
        const [users, total] = await Promise.all([
            db.user.findMany({
                where,
                select: superAdminUserSelect,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                skip: (input.page - 1) * input.limit,
                take: input.limit,
            }),
            db.user.count({ where }),
        ]);
        return { users, total };
    }
);
