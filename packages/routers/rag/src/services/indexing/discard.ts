import type { AuthorizedContext } from '@routers/utils/authorized';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { audit } from '../mutation';
import { requireIndexRebuild } from './access';
import { lockGenerationAdmission } from './generation-acceptance';
import { indexError } from './errors';

/** Fence accepted non-active work and enqueue its physical cleanup without moving the active pointer or accelerating retired sources. */
export function discardIndex(
    context: AuthorizedContext,
    input: { collectionId: string; generationId: string }
) {
    return runSerializableTransaction(context.db, async (tx) => {
        await lockGenerationAdmission(tx, context.organizationId);
        const { actor } = await requireIndexRebuild(
            context,
            input.collectionId,
            tx
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
                organizationId: actor.organizationId,
                collectionId: input.collectionId,
                id: input.generationId,
            },
        });
        if (!generation) throw indexError('GENERATION_CONFLICT');
        if (
            collection.activeGenerationId === generation.id ||
            generation.status === 'ACTIVE'
        )
            throw indexError('GENERATION_CONFLICT');
        if (['RETIRED', 'CLEANING', 'CLEANED'].includes(generation.status))
            return { success: true as const };
        await tx.indexGeneration.update({
            where: { id: generation.id },
            data: {
                status: 'CLEANING',
                retiredAt: new Date(),
                cleanupAfter: new Date(),
                lastErrorCode: null,
            },
        });
        await tx.indexTask.updateMany({
            where: {
                generationId: generation.id,
                organizationId: actor.organizationId,
                kind: {
                    in: ['PROVISION', 'INDEX_DOCUMENT', 'REMOVE_DOCUMENT'],
                },
                status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
            },
            data: {
                status: 'CANCELLED',
                stage: 'DISCARDED',
                leaseToken: null,
                leasedUntil: null,
                leaseEpoch: { increment: 1 },
            },
        });
        await tx.indexTask.upsert({
            where: {
                ['organizationId_dedupeKey']: {
                    organizationId: actor.organizationId,
                    dedupeKey: `clean-generation:${generation.id}`,
                },
            },
            create: {
                organizationId: actor.organizationId,
                collectionId: input.collectionId,
                generationId: generation.id,
                kind: 'CLEAN_GENERATION',
                dedupeKey: `clean-generation:${generation.id}`,
                requestedBy: actor.userId,
            },
            update: {},
        });
        await audit(
            tx,
            actor,
            'collection.index.discarded',
            input.collectionId,
            { generationId: generation.id }
        );
        return { success: true as const };
    });
}
