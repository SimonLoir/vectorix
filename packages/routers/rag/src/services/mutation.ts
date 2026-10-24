import { ORPCError } from '@orpc/server';
import { Prisma } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    isSerializationConflict,
    runSerializableTransaction,
} from '@routers/utils/transactions';
import type { PermissionSet } from '@repo/auth/permissions';
import { ragActor, type RagActor } from './access';

/** All catalog mutations recheck access inside the same serializable transaction as their writes. */
export async function mutate<T>(
    context: AuthorizedContext,
    required: PermissionSet,
    operation: (db: Prisma.TransactionClient, actor: RagActor) => Promise<T>
) {
    try {
        return await runSerializableTransaction(context.db, async (db) =>
            operation(db, await ragActor(context, db, required, true))
        );
    } catch (error) {
        throw normalizeCatalogMutationError(error);
    }
}

/** Map exhausted known database conflicts without exposing driver diagnostics or changing unrelated errors. */
export function normalizeCatalogMutationError(error: unknown): unknown {
    if (isSerializationConflict(error))
        return new ORPCError('CONFLICT', {
            message: 'The resource changed. Reload before retrying.',
        });
    if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2002', 'P2003', 'P2014', 'P2025'].includes(error.code)
    )
        return new ORPCError('CONFLICT', {
            message:
                'The resource changed, already exists, or is still referenced.',
        });
    return error;
}

/** Audit details are an explicit whitelist of identifiers and scalar state, never provider input. */
export async function audit(
    db: Prisma.TransactionClient,
    actor: RagActor,
    action: string,
    targetId: string,
    details: Record<string, string | number | boolean> = {}
) {
    await db.ragAuditLog.create({
        data: {
            organizationId: actor.organizationId,
            actorType: actor.keyId ? 'api-key' : 'user',
            actorId: actor.keyId ?? actor.userId,
            action,
            targetId,
            details,
        },
    });
}
