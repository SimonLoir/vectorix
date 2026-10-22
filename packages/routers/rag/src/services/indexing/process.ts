import type { IndexTask, PrismaClient } from '@repo/db';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    initializeVectorDestination,
    generationVectorAdapter,
} from './generation-adapter';
import { executeDocumentIndex } from './index-document';
import { activateReadyGenerations } from './activation';
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
    type IndexClaim,
} from './task-state';

/** PostgreSQL is the source of task state; Redis only schedules bounded scans without content or secrets. */
export async function processCollectionIndexing(db: PrismaClient) {
    // Bootstrap may be absent in a notification-only deployment. Durable indexing
    // claims below report safe errors; other worker queues continue independently.
    await initializeVectorDestination().catch(() => {});
    const tasks = await db.indexTask.findMany({
        where: {
            availableAt: { lte: new Date() },
            AND: [
                {
                    OR: [
                        { status: 'PENDING' },
                        {
                            status: 'PROCESSING',
                            leasedUntil: { lte: new Date() },
                        },
                    ],
                },
                {
                    OR: [
                        { kind: { not: 'INDEX_DOCUMENT' } },
                        {
                            generation: {
                                status: { in: ['BUILDING', 'ACTIVE'] },
                            },
                        },
                    ],
                },
            ],
        },
        orderBy: [{ availableAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        take: 10,
    });
    for (const task of tasks) {
        const claim = await claimIndexTask(db, task);
        if (!claim) continue;
        try {
            switch (task.kind) {
                case 'PROVISION': {
                    await provision(db, claim, task);
                    break;
                }
                case 'INDEX_DOCUMENT': {
                    await executeDocumentIndex(db, claim, task);
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
        } catch (error) {
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
