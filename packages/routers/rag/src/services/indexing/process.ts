import type { IndexTask, PrismaClient } from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    initializeVectorDestination,
    generationVectorAdapter,
} from './generation-adapter';
import { executeDocumentIndex } from './index-document';
import { requireGenerationChunking } from './generation-profile';
import { SemanticContinuation } from './semantic-capacity';
import { reapSemanticWork } from './semantic-work';
import { activateReadyGenerations } from './activation';
import { scanIndexTasks } from './task-scan';
import { getRagTelemetry } from '../telemetry';
import { indexTelemetryTags, telemetryFailure } from '../telemetry/domain';
import {
    executeDocumentRemoval,
    executeGenerationCleanup,
    executePublicationCleanup,
} from './cleanup-index';
import {
    acknowledgeGenerationChange,
    CandidateObsolete,
    retireIndexedDocument,
} from './publication-state';
import {
    claimIndexTask,
    completeIndexClaim,
    failIndexClaim,
    renewIndexClaim,
    requireIndexAuthority,
    indexErrorCode,
    IndexLeaseLost,
    type IndexClaim,
} from './task-state';

/** PostgreSQL is the source of task state; Redis only schedules bounded scans without content or secrets. */
export async function processCollectionIndexing(db: PrismaClient) {
    await reapSemanticWork(db);
    // Bootstrap may be absent in a notification-only deployment. Durable indexing
    // claims below report safe errors; other worker queues continue independently.
    await initializeVectorDestination().catch(() => {});
    const tasks = await scanIndexTasks(db);
    for (const task of tasks) {
        const claim = await claimIndexTask(db, task);
        if (!claim) continue;
        const tags =
            task.kind === 'INDEX_DOCUMENT'
                ? indexTelemetryTags(
                      task.organizationId,
                      task.generation.configuration
                  )
                : null;
        const execution = tags ? getRagTelemetry(db).start(tags) : undefined;
        try {
            switch (task.kind) {
                case 'PROVISION': {
                    await provision(db, claim, task);
                    break;
                }
                case 'INDEX_DOCUMENT': {
                    await executeDocumentIndex(db, claim, task, execution);
                    break;
                }
                case 'REMOVE_DOCUMENT': {
                    await executeDocumentRemoval(db, claim, task);
                    break;
                }
                case 'CLEAN_PUBLICATION': {
                    await executePublicationCleanup(db, claim, task);
                    break;
                }
                case 'CLEAN_GENERATION':
                    {
                        await executeGenerationCleanup(db, claim, task);
                        // No default
                    }
                    break;
            }
            execution?.finish('SUCCESS');
        } catch (error) {
            if (error instanceof SemanticContinuation) {
                execution?.finish('CONTINUATION');
                continue;
            }
            const failure =
                error instanceof CandidateObsolete
                    ? undefined
                    : telemetryFailure(
                          error instanceof IndexLeaseLost
                              ? 'LEASE_LOST'
                              : indexErrorCode(error)
                      );
            execution?.finish(
                error instanceof CandidateObsolete
                    ? 'SUPERSEDED'
                    : failure === 'ACCESS' || failure === 'LEASE'
                      ? 'DENIED'
                      : 'FAILURE',
                failure
            );
            await (error instanceof CandidateObsolete
                ? supersede(db, claim, task)
                : failIndexClaim(db, claim, error));
        }
    }
    await activateReadyGenerations(db);
}

async function provision(db: PrismaClient, claim: IndexClaim, task: IndexTask) {
    await renewIndexClaim(db, claim, 'PROVISIONING');
    await requireIndexAuthority(db, task);
    await requireGenerationChunking(
        db,
        claim.organizationId,
        claim.generationId
    );
    const binding = await generationVectorAdapter(
        db,
        claim.organizationId,
        claim.generationId,
        { provision: true }
    );
    await binding.store.provision(binding.spec);
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim);
        await requireIndexAuthority(tx, task);
        await tx.indexGeneration.updateMany({
            where: {
                id: claim.generationId,
                status: 'PROVISIONING',
                collection: { deletedAt: null },
            },
            data: { status: 'BUILDING', lastErrorCode: null },
        });
        await completeIndexClaim(tx, claim);
    });
}

async function supersede(db: PrismaClient, claim: IndexClaim, task: IndexTask) {
    await runSerializableTransaction(db, async (tx) => {
        await renewIndexClaim(tx, claim);
        if (task.indexedDocumentId) {
            const candidate = await tx.indexedDocument.findUnique({
                where: { id: task.indexedDocumentId },
            });
            if (candidate)
                await retireIndexedDocument(
                    tx,
                    candidate,
                    task.requestedBy,
                    true
                );
        }
        await acknowledgeGenerationChange(
            tx,
            claim.generationId,
            task.changeSequence,
            'SUPERSEDED'
        );
        await tx.indexTask.update({
            where: { id: task.id },
            data: {
                status: 'CANCELLED',
                stage: 'SUPERSEDED',
                leaseToken: null,
                leasedUntil: null,
            },
        });
    });
}

export { closeVectorAdapters } from './generation-adapter';
