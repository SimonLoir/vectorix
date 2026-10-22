import type { AuthorizedContext } from '@routers/utils/authorized';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { ragActor, requireCollection } from '../access';
import { audit } from '../mutation';
import { requireIndexRebuild } from './access';
import { indexError } from './errors';
import { isPendingRebuild } from './sync-authority';
import { transferSynchronizationController } from './synchronization-fence';

/**
 * Adopt future automatic work and fence current runnable cost tasks in one
 * session-only transaction. Failed work retains its explicit task retry; source,
 * publication, plan, reservation and lifetime usage history are never reset.
 */
export function adoptSynchronization(
    context: AuthorizedContext,
    input: {
        collectionId: string;
        generationId: string;
        expectedAuthorityUserId: string | null;
    }
) {
    return runSerializableTransaction(context.db, async (tx) => {
        const actor = await ragActor(
            context,
            tx,
            { ragCollection: ['manageDocuments'] },
            true
        );
        await requireCollection(
            tx,
            actor,
            input.collectionId,
            'manageDocuments'
        );
        const collection = await tx.collection.update({
            where: {
                ['organizationId_id']: {
                    organizationId: actor.organizationId,
                    id: input.collectionId,
                },
            },
            data: { contentSequence: { increment: 0 } },
        });
        const generation = await tx.indexGeneration.findFirst({
            where: {
                id: input.generationId,
                organizationId: actor.organizationId,
                collectionId: collection.id,
            },
        });
        if (
            !generation ||
            collection.deletedAt ||
            !['PROVISIONING', 'BUILDING', 'ACTIVE', 'FAILED'].includes(
                generation.status
            ) ||
            (generation.status === 'ACTIVE'
                ? collection.activeGenerationId !== generation.id
                : collection.activeGenerationId !==
                  generation.previousGenerationId) ||
            generation.authorityUserId !== input.expectedAuthorityUserId
        )
            throw indexError('GENERATION_CONFLICT');
        if (isPendingRebuild(generation))
            await requireIndexRebuild(context, input.collectionId, tx);
        const counts = await transferSynchronizationController(
            tx,
            generation,
            actor.userId
        );
        await audit(
            tx,
            actor,
            'collection.index.synchronization.adopted',
            collection.id,
            {
                generationId: generation.id,
                ...(generation.authorityUserId
                    ? { previousAuthorityUserId: generation.authorityUserId }
                    : {}),
                authorityUserId: actor.userId,
                ...counts,
            }
        );
        return {
            success: true as const,
            generationId: generation.id,
            authorityUserId: actor.userId,
            ...counts,
        };
    });
}
