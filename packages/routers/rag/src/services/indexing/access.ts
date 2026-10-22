import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import type { Prisma, IndexTask } from '@repo/db';
import { permits } from '@repo/auth/permissions';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
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

/** Rebuilding or discarding changes both a profile's execution and its document work; require both explicit grants and a current session. */
export async function requireIndexRebuild(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
) {
    const actor = await ragActor(
        context,
        db,
        { ragCollection: ['update', 'manageDocuments'] },
        true
    );
    const collection = await db.collection.findFirst({
        where: {
            AND: [
                { id: collectionId },
                grantWhere(actor, 'administer'),
                grantWhere(actor, 'manageDocuments'),
            ],
        },
    });
    if (!collection) throw new ORPCError('NOT_FOUND');
    return { actor, collection };
}

/** Recheck a human executor before document work; global catalog administration never replaces a collection grant. */
export async function requireIndexDocumentAuthority(
    db: Prisma.TransactionClient,
    task: Pick<IndexTask, 'organizationId' | 'collectionId' | 'requestedBy'>
) {
    const membership = await getMemberPermissions(
        task.organizationId,
        task.requestedBy,
        db
    );
    if (
        !membership ||
        !permits(membership.permissions, {
            ragCollection: ['manageDocuments'],
        })
    )
        throw new ORPCError('FORBIDDEN', {
            data: { errorCode: 'ACCESS_REVOKED' },
        });
    const actor: RagActor = {
        organizationId: task.organizationId,
        userId: task.requestedBy,
        memberId: membership.member.id,
        keyId: null,
        permissions: membership.permissions,
    };
    const collection = await db.collection.findFirst({
        where: {
            AND: [
                { id: task.collectionId, organization: { isActive: true } },
                grantWhere(actor, 'manageDocuments'),
            ],
        },
    });
    if (!collection)
        throw new ORPCError('FORBIDDEN', {
            data: { errorCode: 'ACCESS_REVOKED' },
        });
    return collection;
}

/** Rebuild admission and activation additionally require current profile administration. */
export async function requireIndexRebuildAuthority(
    db: Prisma.TransactionClient,
    task: Pick<IndexTask, 'organizationId' | 'collectionId' | 'requestedBy'>
) {
    const membership = await getMemberPermissions(
        task.organizationId,
        task.requestedBy,
        db
    );
    if (
        !membership ||
        !permits(membership.permissions, {
            ragCollection: ['update', 'manageDocuments'],
        })
    )
        throw new ORPCError('FORBIDDEN', {
            data: { errorCode: 'ACCESS_REVOKED' },
        });
    const actor: RagActor = {
        organizationId: task.organizationId,
        userId: task.requestedBy,
        memberId: membership.member.id,
        keyId: null,
        permissions: membership.permissions,
    };
    const collection = await db.collection.findFirst({
        where: {
            AND: [
                { id: task.collectionId, organization: { isActive: true } },
                grantWhere(actor, 'administer'),
                grantWhere(actor, 'manageDocuments'),
            ],
        },
    });
    if (!collection)
        throw new ORPCError('FORBIDDEN', {
            data: { errorCode: 'ACCESS_REVOKED' },
        });
    return collection;
}

/** Status metadata is visible to authorized catalog viewers; documents require a content or management grant. */
export async function indexCapabilities(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
) {
    const actor = await ragActor(context, db, {});
    const deleted = await db.collection.findFirst({
        where: { AND: [{ id: collectionId }, indexCleanupWhere(actor)] },
    });
    if (deleted)
        return {
            actor,
            collection: deleted,
            canRead: false,
            canManage: true,
            canRebuild: false,
        };
    const collection = await requireCollection(
        db,
        actor,
        collectionId,
        'metadata'
    );
    const hasGrant = async (
        action: 'read' | 'manageDocuments' | 'administer'
    ) =>
        permits(actor.permissions, {
            ragCollection: [action === 'administer' ? 'update' : action],
        }) &&
        Boolean(
            await db.collection.findFirst({
                where: {
                    AND: [{ id: collectionId }, grantWhere(actor, action)],
                },
                select: { id: true },
            })
        );
    const [read, manage, administer] = await Promise.all([
        hasGrant('read'),
        hasGrant('manageDocuments'),
        hasGrant('administer'),
    ]);
    return {
        actor,
        collection,
        canRead: read && permits(actor.permissions, { ragLibrary: ['read'] }),
        canManage: manage && !actor.keyId,
        canRebuild: manage && administer && !actor.keyId,
    };
}

/** Recheck management-dependent staged preview access after content hydration, including the current reader publication pointer. */
export async function requireIndexPreviewCompletion(
    context: AuthorizedContext,
    collectionId: string,
    generationId: string | undefined,
    previouslyManaged: boolean
) {
    await requireIndexRead(context, collectionId);
    const current = await indexCapabilities(context, collectionId);
    if (!current.canRead || (previouslyManaged && !current.canManage))
        throw new ORPCError('FORBIDDEN');
    if (
        !current.canManage &&
        (generationId ?? null) !== current.collection.activeGenerationId
    )
        throw new ORPCError('NOT_FOUND');
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
