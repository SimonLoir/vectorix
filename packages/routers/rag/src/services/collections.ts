import { ORPCError } from '@orpc/server';
import { permits } from '@repo/auth/permissions';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { mutate, audit } from './mutation';
import { requireCollection } from './access';
import { quotaLimits } from './quotas';
import { profileData } from './collection-profile';
import { collectionDto } from './collection-view';

type Profile = typeof collectionProfile._output;
export function createCollection(
    context: AuthorizedContext,
    input: {
        name: string;
        description: string;
        profile: Profile;
        grantCreatorRead: boolean;
    }
) {
    return mutate(
        context,
        {
            ragCollection: input.grantCreatorRead
                ? ['create', 'read']
                : ['create'],
        },
        async (db, actor) => {
            const limits = await quotaLimits(db, actor.organizationId);
            if (
                (await db.collection.count({
                    where: {
                        organizationId: actor.organizationId,
                        deletedAt: null,
                    },
                })) >= limits.collections
            )
                throw new ORPCError('CONFLICT', {
                    message: 'The organization collection quota is reached.',
                });
            const profile = await profileData(
                db,
                actor.organizationId,
                input.profile
            );
            const collection = await db.collection.create({
                data: {
                    organizationId: actor.organizationId,
                    name: input.name,
                    description: input.description,
                },
            });
            await db.collectionConfigRevision.create({
                data: {
                    ...profile,
                    organizationId: actor.organizationId,
                    collectionId: collection.id,
                    revision: 1,
                },
            });
            await db.collectionMemberGrant.create({
                data: {
                    organizationId: actor.organizationId,
                    collectionId: collection.id,
                    memberId: actor.memberId,
                    read: input.grantCreatorRead,
                    administer: true,
                    manageDocuments: permits(actor.permissions, {
                        ragCollection: ['manageDocuments'],
                    }),
                },
            });
            await audit(db, actor, 'collection.create', collection.id, {
                revision: 1,
                grantCreatorRead: input.grantCreatorRead,
            });
            return collectionDto(db, actor, collection);
        }
    );
}
export function updateCollection(
    context: AuthorizedContext,
    input: {
        id: string;
        expectedRevision: number;
        name: string;
        description: string;
        profile: Profile;
    }
) {
    return mutate(context, { ragCollection: ['update'] }, async (db, actor) => {
        const current = await requireCollection(
            db,
            actor,
            input.id,
            'administer'
        );
        if (current.configurationRevision !== input.expectedRevision)
            throw new ORPCError('CONFLICT', {
                message:
                    'Collection configuration changed. Reload before updating.',
            });
        const profile = await profileData(
            db,
            actor.organizationId,
            input.profile
        );
        const revision = current.configurationRevision + 1;
        await db.collectionConfigRevision.create({
            data: {
                ...profile,
                organizationId: actor.organizationId,
                collectionId: current.id,
                revision,
            },
        });
        const result = await db.collection.update({
            where: { id: current.id },
            data: {
                name: input.name,
                description: input.description,
                configurationRevision: revision,
            },
        });
        await audit(db, actor, 'collection.update', current.id, { revision });
        return collectionDto(db, actor, result);
    });
}
export function deleteCollection(
    context: AuthorizedContext,
    input: { id: string; expectedRevision: number }
) {
    return mutate(context, { ragCollection: ['delete'] }, async (db, actor) => {
        const current = await requireCollection(
            db,
            actor,
            input.id,
            'administer'
        );
        if (current.configurationRevision !== input.expectedRevision)
            throw new ORPCError('CONFLICT');
        await db.collection.update({
            where: { id: current.id },
            data: { deletedAt: new Date() },
        });
        // Shared library documents survive. Retain immutable revisions for future cleanup/recovery.
        await audit(db, actor, 'collection.delete', current.id);
        return { success: true as const };
    });
}
