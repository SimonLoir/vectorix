import { ORPCError } from '@orpc/server';
import type { Prisma, PrismaClient } from '@repo/db';
import {
    isSerializationConflict,
    runSerializableTransaction,
} from '@routers/utils/transactions';

/** Recheck the session actor inside the transaction that authorizes the mutation. */
export async function requireCurrentSuperAdmin(
    db: Prisma.TransactionClient,
    userId: string
): Promise<void> {
    const actor = await db.user.findUnique({
        where: { id: userId },
        select: { isSuperAdmin: true },
    });
    if (!actor?.isSuperAdmin)
        throw new ORPCError('FORBIDDEN', {
            message: 'Superadmin access has been revoked.',
        });
}

/**
 * Keep current actor checks, target predicates, writes and audit in one retryable
 * database transaction. Callbacks must not send mail or perform external I/O.
 * Owner predicates serialize these superadmin mutations, not native auth paths.
 */
export function runSuperAdminTransaction<T>(
    db: PrismaClient,
    userId: string,
    operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
    return runSerializableTransaction(db, async (tx) => {
        await requireCurrentSuperAdmin(tx, userId);
        return operation(tx);
    }).catch((error: unknown) => {
        if (isSerializationConflict(error))
            throw new ORPCError('CONFLICT', {
                message:
                    'A concurrent change occurred. Reload before trying again.',
            });
        throw error;
    });
}
