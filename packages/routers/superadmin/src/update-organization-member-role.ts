import { ORPCError } from '@orpc/server';
import { auditSuperAdminAction } from './audit';
import { organizationMemberSelect } from './member-select';
import { superAdminV1 } from './v1-implementer';

export const updateOrganizationMemberRole =
    superAdminV1.organizations.members.updateRole.handler(
        async ({ context: { db, headers, user }, input }) => {
            const member = await db.member.findFirst({
                where: {
                    id: input.memberId,
                    organizationId: input.organizationId,
                },
                select: { id: true, role: true },
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
                    .includes('owner') &&
                input.role !== 'owner'
            ) {
                const organizationMembers = await db.member.findMany({
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
                            'Ajoutez un autre propriétaire avant de modifier le dernier propriétaire.',
                    });
                }
            }

            const updated = await db.member.update({
                where: { id: member.id },
                data: { role: input.role },
                select: organizationMemberSelect,
            });

            await auditSuperAdminAction({
                db,
                headers,
                userId: user.id,
                action: 'organization.member.update-role',
                targetId: input.organizationId,
                details: {
                    memberId: member.id,
                    before: member.role,
                    after: input.role,
                },
            });

            return updated;
        }
    );
