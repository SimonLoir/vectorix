import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { ragActor, requireCollection } from '../access';
import { audit } from '../mutation';
import { requireIndexCleanup, requireIndexRebuild } from './access';
import { automaticIndexUser, isPendingRebuild } from './sync-authority';
import { transferSynchronizationController } from './synchronization-fence';

/** Requeue accepted work without replacing its immutable source or releasing unconfirmed reservations. */
export function retryIndexTask(
    context: AuthorizedContext,
    input: { collectionId: string; taskId: string }
) {
    return runSerializableTransaction(context.db, async (tx) => {
        const task = await tx.indexTask.findFirst({
            where: {
                id: input.taskId,
                organizationId: context.organizationId,
                collectionId: input.collectionId,
            },
            include: { indexedDocument: true, generation: true },
        });
        if (!task) throw new ORPCError('NOT_FOUND');
        const cleanup =
            task.kind === 'CLEAN_GENERATION' ||
            task.kind === 'CLEAN_PUBLICATION';
        const collection = await tx.collection.findFirst({
            where: {
                organizationId: context.organizationId,
                id: input.collectionId,
            },
            select: { deletedAt: true },
        });
        const deletedCleanup = cleanup && Boolean(collection?.deletedAt);
        const actor = deletedCleanup
            ? (await requireIndexCleanup(context, input.collectionId, tx)).actor
            : await ragActor(
                  context,
                  tx,
                  { ragCollection: ['manageDocuments'] },
                  true
              );
        if (!deletedCleanup)
            await requireCollection(
                tx,
                actor,
                input.collectionId,
                'manageDocuments'
            );
        const pendingRebuild = isPendingRebuild(task.generation);
        if (!cleanup && pendingRebuild)
            await requireIndexRebuild(context, input.collectionId, tx);
        if (
            !cleanup &&
            !['PROVISIONING', 'BUILDING', 'ACTIVE', 'FAILED'].includes(
                task.generation.status
            )
        )
            throw new ORPCError('CONFLICT');
        if (task.status !== 'FAILED')
            throw new ORPCError('CONFLICT', {
                message: 'This indexing task is not waiting for a retry.',
            });
        if (task.kind === 'INDEX_DOCUMENT' && task.indexedDocument) {
            const candidate = task.indexedDocument;
            const desired = await tx.generationDocument.findUnique({
                where: {
                    ['generationId_documentId']: {
                        generationId: task.generationId,
                        documentId: candidate.documentId,
                    },
                },
            });
            if (
                !desired ||
                desired.removedAt ||
                desired.buildRevision !== candidate.buildRevision ||
                desired.desiredVersionId !== candidate.sourceVersionId ||
                ['CLEANING', 'CLEANED', 'RETIRED'].includes(candidate.status)
            )
                throw new ORPCError('CONFLICT', {
                    message:
                        'This task was superseded by a newer document change.',
                });
        }
        const pendingGeneration =
            !cleanup &&
            (pendingRebuild ||
                task.kind === 'PROVISION' ||
                task.kind === 'INDEX_DOCUMENT') &&
            ['PROVISIONING', 'BUILDING', 'FAILED'].includes(
                task.generation.status
            );
        const transfersController =
            pendingGeneration &&
            (pendingRebuild
                ? automaticIndexUser(task.generation, task.generation.createdBy)
                : task.generation.authorityUserId) !== actor.userId;
        let transferred:
            | { reboundPendingTasks: number; interruptedTasks: number }
            | undefined;
        if (transfersController) {
            // Preserve initial/rebuild retry activation authority while
            // fencing all its old runnable epochs before changing authority.
            await tx.collection.update({
                where: {
                    ['organizationId_id']: {
                        organizationId: actor.organizationId,
                        id: input.collectionId,
                    },
                },
                data: { contentSequence: { increment: 0 } },
            });
            transferred = await transferSynchronizationController(
                tx,
                task.generation,
                actor.userId
            );
        }
        await tx.indexTask.update({
            where: { id: task.id },
            data: {
                status: 'PENDING',
                attempts: 0,
                continuationPending: false,
                errorCode: null,
                availableAt: new Date(),
                leaseToken: null,
                leasedUntil: null,
                leaseEpoch: { increment: 1 },
                ...(cleanup ? {} : { requestedBy: actor.userId }),
            },
        });
        await tx.indexGeneration.updateMany({
            where: {
                id: task.generationId,
                organizationId: actor.organizationId,
                status: 'FAILED',
            },
            data: {
                status: task.kind === 'PROVISION' ? 'PROVISIONING' : 'BUILDING',
                lastErrorCode: null,
            },
        });
        if (pendingGeneration && !transfersController)
            await tx.indexGeneration.update({
                where: { id: task.generationId },
                data: { authorityUserId: actor.userId },
            });
        await audit(tx, actor, 'collection.index.retry', input.collectionId, {
            taskId: task.id,
            generationId: task.generationId,
            ...(transferred
                ? { synchronizationTransferred: true, ...transferred }
                : {}),
        });
        return { success: true as const };
    });
}
