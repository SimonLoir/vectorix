import { ORPCError } from '@orpc/server';
import {
    isSerializationConflict,
    runSerializableTransaction,
} from '@routers/utils/transactions';
import { auditSuperAdminAction } from './audit';
import { superAdminUserSelect } from './user-select';
import { superAdminV1 } from './v1-implementer';

/** Serializes privilege changes with a fresh actor check, exact user snapshot and last-superadmin guard. */
export const setUserSuperAdmin = superAdminV1.users.setSuperAdmin.handler(
    ({ context: { db, headers, user: actor }, input }) =>
        runSerializableTransaction(db, async (tx) => {
            const currentActor = await tx.user.findUnique({
                where: { id: actor.id },
                select: { isSuperAdmin: true },
            });
            if (!currentActor?.isSuperAdmin)
                throw new ORPCError('FORBIDDEN', {
                    message: 'Votre accès superadmin a été retiré.',
                });
            const before = await tx.user.findUnique({
                where: { id: input.userId },
                select: superAdminUserSelect,
            });
            if (!before)
                throw new ORPCError('NOT_FOUND', {
                    message: 'Utilisateur introuvable.',
                });
            if (
                before.isSuperAdmin !== input.expectedIsSuperAdmin ||
                before.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()
            )
                throw new ORPCError('CONFLICT', {
                    message:
                        'Cet utilisateur a changé. Rechargez sa fiche avant de continuer.',
                });
            if (before.isSuperAdmin === input.enabled) return before;
            if (!input.enabled) {
                const remaining = await tx.user.count({
                    where: { isSuperAdmin: true, id: { not: before.id } },
                });
                if (remaining === 0)
                    throw new ORPCError('BAD_REQUEST', {
                        message:
                            'Nommez un autre superadmin avant de retirer l’accès du dernier superadmin.',
                    });
            }
            const user = await tx.user.update({
                where: { id: before.id },
                data: { isSuperAdmin: input.enabled },
                select: superAdminUserSelect,
            });
            await auditSuperAdminAction({
                db: tx,
                headers,
                userId: actor.id,
                action: 'user.setSuperAdmin',
                targetId: before.id,
                details: {
                    before: { isSuperAdmin: before.isSuperAdmin },
                    after: { isSuperAdmin: user.isSuperAdmin },
                },
            });
            return user;
        }).catch((error: unknown) => {
            if (isSerializationConflict(error))
                throw new ORPCError('CONFLICT', {
                    message:
                        'Un changement concurrent a eu lieu. Rechargez la fiche avant de continuer.',
                });
            throw error;
        })
);
