import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { hashPassword } from 'better-auth/crypto';
import { auditSuperAdminAction } from './audit';
import { organizationMemberSelect } from './member-select';
import { superAdminV1 } from './v1-implementer';

export const addOrganizationMember =
    superAdminV1.organizations.members.add.handler(
        async ({ context: { db, headers, user: actor }, input }) => {
            const email = input.email.trim().toLowerCase();
            const organization = await db.organization.findUnique({
                where: { id: input.organizationId },
                select: { id: true },
            });
            if (!organization) {
                throw new ORPCError('NOT_FOUND', {
                    message: 'Organisation introuvable.',
                });
            }

            const existingUser = await db.user.findUnique({
                where: { email },
                select: { id: true },
            });
            if (!existingUser && (!input.name || !input.password)) {
                throw new ORPCError('BAD_REQUEST', {
                    message:
                        'Le nom et le mot de passe temporaire sont requis pour créer un utilisateur.',
                });
            }

            const passwordHash =
                existingUser || !input.password
                    ? null
                    : await hashPassword(input.password);
            const now = new Date();
            const result = await db.$transaction(async (tx) => {
                let accountUser = await tx.user.findUnique({
                    where: { email },
                });
                const userCreated = !accountUser;

                if (!accountUser) {
                    const userId = randomUUID();
                    accountUser = await tx.user.create({
                        data: {
                            id: userId,
                            name: input.name!,
                            email,
                            emailVerified: input.emailVerified,
                        },
                    });
                    await tx.account.create({
                        data: {
                            id: randomUUID(),
                            accountId: userId,
                            providerId: 'credential',
                            userId,
                            password: passwordHash!,
                            createdAt: now,
                            updatedAt: now,
                        },
                    });
                }

                const existingMember = await tx.member.findFirst({
                    where: {
                        organizationId: input.organizationId,
                        userId: accountUser.id,
                    },
                    select: { id: true },
                });
                if (existingMember) {
                    throw new ORPCError('CONFLICT', {
                        message:
                            'Cet utilisateur est déjà membre de l’organisation.',
                    });
                }

                const member = await tx.member.create({
                    data: {
                        id: randomUUID(),
                        organizationId: input.organizationId,
                        userId: accountUser.id,
                        role: input.role,
                        createdAt: now,
                    },
                    select: organizationMemberSelect,
                });

                return { member, userCreated };
            });

            await auditSuperAdminAction({
                db,
                headers,
                userId: actor.id,
                action: result.userCreated
                    ? 'organization.member.create-user'
                    : 'organization.member.add-existing-user',
                targetId: input.organizationId,
                details: {
                    memberId: result.member.id,
                    memberUserId: result.member.user.id,
                    email,
                    role: input.role,
                },
            });

            return result;
        }
    );
