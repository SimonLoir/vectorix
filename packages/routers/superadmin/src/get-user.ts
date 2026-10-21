import { ORPCError } from '@orpc/server';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { superAdminUserSelect } from './user-select';
import { superAdminV1 } from './v1-implementer';

/** Reads the selected account and a bounded page of its organization memberships from one snapshot. */
export const getSuperAdminUser = superAdminV1.users.get.handler(
    ({ context: { db }, input }) =>
        runSerializableTransaction(db, async (tx) => {
            const user = await tx.user.findUnique({
                where: { id: input.userId },
                select: superAdminUserSelect,
            });
            if (!user)
                throw new ORPCError('NOT_FOUND', {
                    message: 'Utilisateur introuvable.',
                });
            const [memberships, superAdminCount] = await Promise.all([
                tx.member.findMany({
                    where: { userId: user.id },
                    select: {
                        id: true,
                        role: true,
                        createdAt: true,
                        organization: {
                            select: {
                                id: true,
                                name: true,
                                slug: true,
                                isActive: true,
                            },
                        },
                    },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                    skip: (input.page - 1) * input.limit,
                    take: input.limit,
                }),
                tx.user.count({ where: { isSuperAdmin: true } }),
            ]);
            return {
                user,
                memberships,
                superAdminCount,
                totalMemberships: user._count.members,
            };
        })
);
