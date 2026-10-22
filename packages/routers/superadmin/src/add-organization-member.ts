import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { hashPassword } from 'better-auth/crypto';
import { auditSuperAdminAction } from './audit';
import { organizationMemberSelect } from './member-select';
import { superAdminV1 } from './v1-implementer';
import { runSuperAdminTransaction } from './superadmin-transaction';

export const addOrganizationMember =
    superAdminV1.organizations.members.add.handler(
        async ({ context: { db, headers, user: actor }, input }) => {
            const email = input.email.trim().toLowerCase();
            // Password hashing is CPU work; do it before entering any retryable transaction.
            const passwordHash = input.password
                ? await hashPassword(input.password)
                : null;
            return runSuperAdminTransaction(db, actor.id, async (tx) => {
                const organization = await tx.organization.findUnique({
                    where: { id: input.organizationId },
                    select: { id: true },
                });
                if (!organization) {
                    throw new ORPCError('NOT_FOUND', {
                        message: 'Organisation introuvable.',
                    });
                }
                let accountUser = await tx.user.findUnique({
                    where: { email },
                });
                const userCreated = !accountUser;
                const now = new Date();
                if (!accountUser) {
                    if (!input.name || !passwordHash) {
                        throw new ORPCError('BAD_REQUEST', {
                            message:
                                'Le nom et le mot de passe temporaire sont requis pour créer un utilisateur.',
                        });
                    }
                    const userId = randomUUID();
                    accountUser = await tx.user.create({
                        data: {
                            id: userId,
                            name: input.name,
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
                            password: passwordHash,
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

                await auditSuperAdminAction({
                    db: tx,
                    headers,
                    userId: actor.id,
                    action: userCreated
                        ? 'organization.member.create-user'
                        : 'organization.member.add-existing-user',
                    targetId: input.organizationId,
                    details: {
                        memberId: member.id,
                        memberUserId: member.user.id,
                        email,
                        role: input.role,
                    },
                });
                return { member, userCreated };
            });
        }
    );
