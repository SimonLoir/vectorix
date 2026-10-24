import { Prisma } from '@repo/db';
import { permits } from '@repo/auth/permissions';
import type { RagActor } from '../access';
import { libraryWrite } from '../documents/access';
import type { OperationCategory } from './types';

type Grant = 'read' | 'manageDocuments' | 'administer';

/** Fixed SQL columns only; values and current member/group identity remain parameterized. */
function grant(actor: RagActor, action: Grant) {
    const memberColumns = {
        read: Prisma.sql`member_grant.read`,
        manageDocuments: Prisma.sql`member_grant."manageDocuments"`,
        administer: Prisma.sql`member_grant.administer`,
    };
    const groupColumns = {
        read: Prisma.sql`group_grant.read`,
        manageDocuments: Prisma.sql`group_grant."manageDocuments"`,
        administer: Prisma.sql`group_grant.administer`,
    };
    return Prisma.sql`(
        EXISTS (SELECT 1 FROM "CollectionMemberGrant" member_grant
            WHERE member_grant."organizationId"=${actor.organizationId}
                AND member_grant."collectionId"=target.id
                AND member_grant."memberId"=${actor.memberId} AND ${memberColumns[action]})
        OR EXISTS (SELECT 1 FROM "CollectionGroupGrant" group_grant
            JOIN "GroupMember" group_member ON group_member."organizationId"=group_grant."organizationId"
                AND group_member."groupId"=group_grant."groupId"
            WHERE group_grant."organizationId"=${actor.organizationId}
                AND group_grant."collectionId"=target.id
                AND group_member."memberId"=${actor.memberId} AND ${groupColumns[action]})
    )`;
}

/** Mirrors collectionMetadataWhere and indexCleanupWhere without granting content access. */
function collectionAccess(actor: RagActor) {
    if (permits(actor.permissions, { ragCollection: ['manageAll'] }))
        return Prisma.sql`TRUE`;
    const read = permits(actor.permissions, { ragCollection: ['read'] });
    const manage = permits(actor.permissions, {
        ragCollection: ['manageDocuments'],
    });
    const administer = ['update', 'delete', 'manageGrants'].some((action) =>
        permits(actor.permissions, { ragCollection: [action] })
    );
    const deleteCollection = permits(actor.permissions, {
        ragCollection: ['delete'],
    });
    return Prisma.sql`(
        (target."deletedAt" IS NULL AND (
            (${read} AND ${grant(actor, 'read')})
            OR (${manage} AND ${grant(actor, 'manageDocuments')})
            OR (${administer} AND ${grant(actor, 'administer')})))
        OR (target."deletedAt" IS NOT NULL AND (
            (${manage} AND ${grant(actor, 'manageDocuments')})
            OR (${deleteCollection} AND ${grant(actor, 'administer')})))
    )`;
}

/** Mirrors documentWhere plus the library-read gate; metadata administration is insufficient. */
function documentAccess(actor: RagActor) {
    if (!permits(actor.permissions, { ragLibrary: ['read'] }))
        return Prisma.sql`FALSE`;
    if (permits(actor.permissions, { ragLibrary: ['readAll'] }))
        return Prisma.sql`target."deletedAt" IS NULL`;
    if (!permits(actor.permissions, { ragCollection: ['read'] }))
        return Prisma.sql`FALSE`;
    // The nested collection uses the same fixed alias as the grant helper.
    return Prisma.sql`target."deletedAt" IS NULL AND EXISTS (
        SELECT 1 FROM "CollectionDocument" association
        JOIN "Collection" target ON target."organizationId"=association."organizationId"
            AND target.id=association."collectionId"
        WHERE association."organizationId"=${actor.organizationId}
            AND association."documentId"=version."documentId" AND target."deletedAt" IS NULL
            AND ${grant(actor, 'read')}
    )`;
}

/**
 * Current-work comparisons require SQL, so the same query must also apply ACLs
 * before LIMIT/OFFSET. Keep these predicates aligned with the shared access
 * helpers; loading every eligible task/collection ID into JS is unbounded.
 */
export function operationAccess(actor: RagActor, category: OperationCategory) {
    if (actor.keyId) return Prisma.sql`FALSE`;
    if (category === 'INDEXING') return collectionAccess(actor);
    return category === 'DOCUMENT_CLEANUP'
        ? Prisma.sql`${permits(actor.permissions, libraryWrite)}`
        : documentAccess(actor);
}
