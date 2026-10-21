import { ORPCError } from '@orpc/server';
import { type Prisma } from '@repo/db';
import {
    permits,
    validatePermissions,
    type PermissionSet,
} from '@repo/auth/permissions';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import type { AuthorizedContext } from '@routers/utils/authorized';

export type RagActor = {
    organizationId: string;
    memberId: string;
    userId: string;
    keyId: string | null;
    permissions: PermissionSet;
};

/** Resolve current membership and key issuer on every request; old keys receive no implicit RAG access. */
export async function ragActor(
    context: AuthorizedContext,
    db: Prisma.TransactionClient,
    required: PermissionSet,
    sessionOnly = false
): Promise<RagActor> {
    const organizationId = context.organizationId;
    const organization = await db.organization.findUnique({
        where: { id: organizationId },
        select: { isActive: true },
    });
    if (!organization?.isActive || (sessionOnly && context.key))
        throw new ORPCError('FORBIDDEN');
    let userId = context.user?.id;
    let keyPermissions: PermissionSet | null = null;
    if (context.key) {
        const principal = await db.apiKeyPrincipal.findFirst({
            where: { organizationId, keyId: context.key.id },
            include: { member: true, key: true },
        });
        if (
            !principal ||
            principal.key.vectorixLegacyFullAccess ||
            principal.key.enabled === false ||
            (principal.key.expiresAt &&
                principal.key.expiresAt <= new Date()) ||
            principal.key.referenceId !== organizationId ||
            principal.key.configId !== 'org'
        )
            throw new ORPCError('FORBIDDEN');
        userId = principal.member.userId;
        try {
            keyPermissions = validatePermissions(
                JSON.parse(principal.key.permissions ?? '{}'),
                true
            );
        } catch {
            throw new ORPCError('FORBIDDEN');
        }
    }
    if (!userId) throw new ORPCError('FORBIDDEN');
    const membership = await getMemberPermissions(organizationId, userId, db);
    if (!membership) throw new ORPCError('FORBIDDEN');
    const permissions = keyPermissions
        ? Object.fromEntries(
              Object.entries(membership.permissions).map(
                  ([resource, actions]) => [
                      resource,
                      actions.filter((action) =>
                          keyPermissions?.[resource]?.includes(action)
                      ),
                  ]
              )
          )
        : membership.permissions;
    if (!permits(permissions, required)) throw new ORPCError('FORBIDDEN');
    return {
        organizationId,
        memberId: membership.member.id,
        userId,
        keyId: context.key?.id ?? null,
        permissions,
    };
}

type GrantAction = 'read' | 'manageDocuments' | 'administer';
/** Express grants in SQL through Prisma so filtering happens before pagination. */
export function grantWhere(
    actor: RagActor,
    action: GrantAction
): Prisma.CollectionWhereInput {
    const base: Prisma.CollectionWhereInput = {
        organizationId: actor.organizationId,
        deletedAt: null,
        OR: [
            {
                memberGrants: {
                    some: {
                        organizationId: actor.organizationId,
                        memberId: actor.memberId,
                        [action]: true,
                    },
                },
            },
            {
                groupGrants: {
                    some: {
                        organizationId: actor.organizationId,
                        [action]: true,
                        group: {
                            members: {
                                some: {
                                    organizationId: actor.organizationId,
                                    memberId: actor.memberId,
                                },
                            },
                        },
                    },
                },
            },
        ],
    };
    if (actor.keyId) {
        if (action === 'administer') return { ...base, id: { in: [] } };
        base.AND = [
            {
                keyScopes: {
                    some: {
                        organizationId: actor.organizationId,
                        keyId: actor.keyId,
                        [action]: true,
                    },
                },
            },
        ];
    }
    return base;
}

export function collectionMetadataWhere(
    actor: RagActor
): Prisma.CollectionWhereInput {
    const base = { organizationId: actor.organizationId, deletedAt: null };
    if (
        !actor.keyId &&
        permits(actor.permissions, { ragCollection: ['manageAll'] })
    )
        return base;
    const alternatives = [
        ...(permits(actor.permissions, { ragCollection: ['read'] })
            ? [grantWhere(actor, 'read')]
            : []),
        ...(permits(actor.permissions, { ragCollection: ['manageDocuments'] })
            ? [grantWhere(actor, 'manageDocuments')]
            : []),
        ...(!actor.keyId &&
        ['update', 'delete', 'manageGrants'].some((action) =>
            permits(actor.permissions, { ragCollection: [action] })
        )
            ? [grantWhere(actor, 'administer')]
            : []),
    ];
    // An explicit impossible ID predicate avoids relying on empty OR normalization.
    return alternatives.length
        ? { ...base, OR: alternatives }
        : { ...base, id: { in: [] } };
}

/** Collection administration is independent of content reading. */
export async function requireCollection(
    db: Prisma.TransactionClient,
    actor: RagActor,
    id: string,
    action: GrantAction | 'metadata'
) {
    const where =
        action === 'metadata'
            ? collectionMetadataWhere(actor)
            : action === 'administer' &&
                !actor.keyId &&
                permits(actor.permissions, { ragCollection: ['manageAll'] })
              ? { organizationId: actor.organizationId, deletedAt: null }
              : grantWhere(actor, action);
    const collection = await db.collection.findFirst({
        where: { AND: [{ id }, where] },
    });
    if (!collection) throw new ORPCError('NOT_FOUND');
    return collection;
}

/** Library managers see the full library; other principals only see documents in readable collections. */
export function documentWhere(actor: RagActor): Prisma.DocumentWhereInput {
    const base: Prisma.DocumentWhereInput = {
        organizationId: actor.organizationId,
        deletedAt: null,
    };
    if (!actor.keyId && permits(actor.permissions, { ragLibrary: ['readAll'] }))
        return base;
    if (!permits(actor.permissions, { ragCollection: ['read'] }))
        return { ...base, id: { in: [] } };
    return {
        ...base,
        collections: {
            some: {
                organizationId: actor.organizationId,
                collection: grantWhere(actor, 'read'),
            },
        },
    };
}
