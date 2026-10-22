import { ORPCError } from '@orpc/server';
import { auditSuperAdminAction } from './audit';
import { superAdminV1 } from './v1-implementer';
import { runSuperAdminTransaction } from './superadmin-transaction';

export const removeOrganizationMember =
    superAdminV1.organizations.members.remove.handler(
        ({ context: { db, headers, user }, input }) =>
            runSuperAdminTransaction(db, user.id, async (tx) => {
                const member = await tx.member.findFirst({
                    where: {
                        id: input.memberId,
                        organizationId: input.organizationId,
                    },
                    select: {
                        id: true,
                        role: true,
                        userId: true,
                        user: { select: { email: true } },
                    },
                });
                if (!member) {
                    throw new ORPCError('NOT_FOUND', {
                        message: 'Membre introuvable dans cette organisation.',
                    });
                }

                if (
                    member.role
                        .split(',')
                        .map((role) => role.trim())
                        .includes('owner')
                ) {
                    const organizationMembers = await tx.member.findMany({
                        where: {
                            organizationId: input.organizationId,
                        },
                        select: { role: true },
                    });
                    const ownerCount = organizationMembers.filter(({ role }) =>
                        role
                            .split(',')
                            .map((name) => name.trim())
                            .includes('owner')
                    ).length;
                    if (ownerCount <= 1) {
                        throw new ORPCError('BAD_REQUEST', {
                            message:
                                'Le dernier propriétaire de l’organisation ne peut pas être supprimé.',
                        });
                    }
                }

                await tx.member.delete({ where: { id: member.id } });
                await tx.session.updateMany({
                    where: {
                        userId: member.userId,
                        activeOrganizationId: input.organizationId,
                    },
                    data: { activeOrganizationId: null },
                });

                await auditSuperAdminAction({
                    db: tx,
                    headers,
                    userId: user.id,
                    action: 'organization.member.remove',
                    targetId: input.organizationId,
                    details: {
                        memberId: member.id,
                        memberUserId: member.userId,
                        email: member.user.email,
                        role: member.role,
                    },
                });

                return { success: true as const };
            })
    );
