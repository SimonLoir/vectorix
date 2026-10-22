import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import type { Prisma } from '@repo/db';
import { permits } from '@repo/auth/permissions';
import {
    ragActor,
    requireCollection,
    grantWhere,
    type RagActor,
} from '../access';

/** Cleanup metadata never implies content access; scoped keys cannot administer deleted collections. */
export function indexCleanupWhere(
    actor: RagActor
): Prisma.CollectionWhereInput {
    const base = {
        organizationId: actor.organizationId,
        deletedAt: { not: null },
    };
    if (actor.keyId) return { ...base, id: { in: [] } };
    if (permits(actor.permissions, { ragCollection: ['manageAll'] }))
        return base;
    const alternatives: Prisma.CollectionWhereInput[] = [];
    if (permits(actor.permissions, { ragCollection: ['manageDocuments'] }))
        alternatives.push({
            ...grantWhere(actor, 'manageDocuments'),
            deletedAt: { not: null },
        });
    if (permits(actor.permissions, { ragCollection: ['delete'] }))
        alternatives.push({
            ...grantWhere(actor, 'administer'),
            deletedAt: { not: null },
        });
    return alternatives.length
        ? { ...base, OR: alternatives }
        : { ...base, id: { in: [] } };
}

/** Previously accepted destructive cleanup can be inspected/retried without reviving a tombstoned collection. */
export async function requireIndexCleanup(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
) {
    const actor = await ragActor(context, db, {}, true);
    const collection = await db.collection.findFirst({
        where: { AND: [{ id: collectionId }, indexCleanupWhere(actor)] },
    });
    if (!collection) throw new ORPCError('NOT_FOUND');
    return { actor, collection };
}

/** Read permission is independent of global catalog administration and document management. */
export async function requireIndexRead(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
) {
    const actor = await ragActor(context, db, {
        ragCollection: ['read'],
        ragLibrary: ['read'],
    });
    const collection = await requireCollection(db, actor, collectionId, 'read');
    return { actor, collection };
}

/** Status metadata is visible to authorized catalog viewers; documents require a content or management grant. */
export async function indexCapabilities(
    context: AuthorizedContext,
    collectionId: string
) {
    const actor = await ragActor(context, context.db, {});
    const deleted = await context.db.collection.findFirst({
        where: { AND: [{ id: collectionId }, indexCleanupWhere(actor)] },
    });
    if (deleted)
        return { actor, collection: deleted, canRead: false, canManage: true };
    const collection = await requireCollection(
        context.db,
        actor,
        collectionId,
        'metadata'
    );
    const hasGrant = async (action: 'read' | 'manageDocuments') =>
        permits(actor.permissions, { ragCollection: [action] }) &&
        Boolean(
            await context.db.collection.findFirst({
                where: {
                    AND: [{ id: collectionId }, grantWhere(actor, action)],
                },
                select: { id: true },
            })
        );
    const [read, manage] = await Promise.all([
        hasGrant('read'),
        hasGrant('manageDocuments'),
    ]);
    return {
        actor,
        collection,
        canRead: read && permits(actor.permissions, { ragLibrary: ['read'] }),
        canManage: manage && !actor.keyId,
    };
}

/** Fail closed rather than leaking library names through a catalog-only grant. */
export async function requireIndexDocuments(
    context: AuthorizedContext,
    collectionId: string
) {
    const capabilities = await indexCapabilities(context, collectionId);
    if (
        !(capabilities.canRead || capabilities.canManage) ||
        !permits(capabilities.actor.permissions, { ragLibrary: ['read'] })
    )
        throw new ORPCError('FORBIDDEN');
    return capabilities;
}
