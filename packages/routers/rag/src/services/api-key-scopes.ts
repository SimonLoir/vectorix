import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { permits, type PermissionSet } from '@repo/auth/permissions';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { collectionScopes } from '@repo/api-contracts/v1/rag/common';
import { ragActor, requireCollection } from './access';
import { audit } from './mutation';

type Scopes = typeof collectionScopes._output;

/** Recheck delegation within the key-write transaction, including concurrent role revocation. */
export async function authorizeKeyMutation(
    context: AuthorizedContext,
    db: Prisma.TransactionClient,
    permissions: PermissionSet,
    action: 'create' | 'update'
) {
    const actor = await ragActor(context, db, { apiKey: [action] }, true);
    if (!permits(actor.permissions, permissions))
        throw new ORPCError('FORBIDDEN');
    return actor;
}

/** Record permission-only updates without storing key material or request bodies. */
export async function auditKeyPermissions(
    context: AuthorizedContext,
    db: Prisma.TransactionClient,
    keyId: string,
    permissions: PermissionSet
) {
    const actor = await authorizeKeyMutation(
        context,
        db,
        permissions,
        'update'
    );
    await audit(db, actor, 'apiKey.permissions.update', keyId);
}
/** Scopes are explicit, organization-local, and no broader than the issuer's current content rights. */
export async function validateKeyScopes(
    context: AuthorizedContext,
    db: Prisma.TransactionClient,
    scopes: Scopes
) {
    const actor = await ragActor(context, db, {}, true);
    for (const scope of scopes) {
        if (!scope.read && !scope.manageDocuments)
            throw new ORPCError('BAD_REQUEST', {
                message: 'An empty collection scope is not permitted.',
            });
        for (const action of ['read', 'manageDocuments'] as const) {
            if (!scope[action]) continue;
            if (!permits(actor.permissions, { ragCollection: [action] }))
                throw new ORPCError('FORBIDDEN');
            await requireCollection(db, actor, scope.collectionId, action);
        }
    }
    return actor;
}

/** Bind new keys only; historical keys without an issuer remain unable to access RAG resources. */
export async function bindKeyScopes(
    context: AuthorizedContext,
    db: Prisma.TransactionClient,
    keyId: string,
    scopes: Scopes,
    creating = false
) {
    const actor = await validateKeyScopes(context, db, scopes);
    const key = await db.apikey.findFirst({
        where: {
            id: keyId,
            configId: 'org',
            referenceId: actor.organizationId,
        },
    });
    if (!key) throw new ORPCError('NOT_FOUND');
    const principal = await db.apiKeyPrincipal.findFirst({
        where: { organizationId: actor.organizationId, keyId },
    });
    if (principal && principal.memberId !== actor.memberId)
        throw new ORPCError('FORBIDDEN', {
            message: 'Only the key issuer can change its collection scopes.',
        });
    if (!principal && !creating)
        throw new ORPCError('CONFLICT', {
            message:
                'Create a new key to bind an issuer and collection scopes.',
        });
    if (!principal)
        await db.apiKeyPrincipal.create({
            data: {
                organizationId: actor.organizationId,
                keyId,
                memberId: actor.memberId,
            },
        });
    await db.apiKeyCollectionScope.deleteMany({
        where: { organizationId: actor.organizationId, keyId },
    });
    if (scopes.length)
        await db.apiKeyCollectionScope.createMany({
            data: scopes.map((scope) => ({
                ...scope,
                organizationId: actor.organizationId,
                keyId,
            })),
        });
    await audit(
        db,
        actor,
        creating ? 'apiKey.create' : 'apiKey.scopes.update',
        keyId,
        { collectionCount: scopes.length }
    );
}
