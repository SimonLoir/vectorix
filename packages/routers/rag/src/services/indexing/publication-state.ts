import type { IndexedDocument, IndexTask, Prisma } from '@repo/db';
import { SOURCE_RETIRE_GRACE_MS } from './source-retention';
import { retireSourceHold } from './source-holds';
import { releaseSemanticWorkAllowance } from './semantic-work';
import {
    IndexingError,
    renewIndexClaim,
    completeIndexClaim,
    type IndexClaim,
} from './task-state';

/** Superseded work is retired safely rather than treated as a provider failure. */
export class CandidateObsolete extends Error {}

/** Validate exact desired version, extraction and metadata under the same serializable transaction as writes. */
export async function requireCurrentCandidate(
    tx: Prisma.TransactionClient,
    claim: IndexClaim,
    candidateId: string
) {
    const candidate = await tx.indexedDocument.findFirst({
        where: {
            id: candidateId,
            organizationId: claim.organizationId,
            generationId: claim.generationId,
        },
        include: {
            sourceVersion: { include: { document: true } },
            extraction: true,
        },
    });
    if (
        !candidate ||
        !['STAGING', 'SEALED', 'PUBLISHED'].includes(candidate.status)
    )
        throw new CandidateObsolete();
    const desired = await tx.generationDocument.findUnique({
        where: {
            ['generationId_documentId']: {
                generationId: claim.generationId,
                documentId: candidate.documentId,
            },
        },
    });
    const association = await tx.collectionDocument.findUnique({
        where: {
            ['collectionId_documentId']: {
                collectionId: claim.collectionId,
                documentId: candidate.documentId,
            },
        },
    });
    const generation = await tx.indexGeneration.findUniqueOrThrow({
        where: { id: claim.generationId },
        include: { collection: true },
    });
    if (
        !desired ||
        desired.removedAt ||
        desired.buildRevision !== candidate.buildRevision ||
        desired.desiredVersionId !== candidate.sourceVersionId ||
        desired.desiredExtractionId !== candidate.extractionId ||
        desired.desiredMetadataRevision !== candidate.metadataRevision ||
        desired.desiredChangeSequence !== candidate.sourceChangeSequence ||
        !association ||
        association.metadataRevision !== candidate.metadataRevision ||
        candidate.sourceVersion.document.deletedAt ||
        candidate.sourceVersion.discardedAt ||
        candidate.sourceVersion.contentState !== 'AVAILABLE' ||
        candidate.extraction.discardedAt ||
        generation.collection.deletedAt ||
        !['BUILDING', 'ACTIVE'].includes(generation.status)
    )
        throw new CandidateObsolete();
    return { candidate, desired, generation };
}

/** Retire publication/source with a shared grace; physical deletion is a separate durable task. */
export async function retireIndexedDocument(
    tx: Prisma.TransactionClient,
    candidate: IndexedDocument,
    requestedBy: string,
    immediate = false,
    absoluteRetainUntil?: Date
) {
    if (['CLEANING', 'CLEANED'].includes(candidate.status)) return;
    await releaseSemanticWorkAllowance(tx, candidate.id);
    const alreadyRetired = candidate.status === 'RETIRED';
    const activeGeneration = await tx.collection.count({
        where: {
            id: candidate.collectionId,
            activeGenerationId: candidate.generationId,
        },
    });
    const generation = await tx.indexGeneration.findUniqueOrThrow({
        where: { id: candidate.generationId },
        select: { activatedAt: true },
    });
    if (!alreadyRetired && candidate.status === 'PUBLISHED' && activeGeneration)
        await tx.collectionIndexAccounting.update({
            where: { collectionId: candidate.collectionId },
            data: {
                activeChunks: { decrement: candidate.materializedChunks },
                retainedChunks: { increment: candidate.materializedChunks },
                revision: { increment: 1 },
            },
        });
    const requestedDeadline =
        absoluteRetainUntil ??
        new Date(
            Date.now() +
                (!generation.activatedAt ||
                (immediate && candidate.status !== 'PUBLISHED')
                    ? 0
                    : SOURCE_RETIRE_GRACE_MS)
        );
    const hold = await tx.documentSourceHold.findUnique({
        where: { indexedDocumentId: candidate.id },
        select: { retainUntil: true },
    });
    const deadline = new Date(
        Math.max(requestedDeadline.getTime(), hold?.retainUntil?.getTime() ?? 0)
    );
    if (!alreadyRetired) {
        await tx.indexedDocument.update({
            where: { id: candidate.id },
            data: { status: 'RETIRED', retiredAt: new Date() },
        });
        await retireSourceHold(tx, {
            organizationId: candidate.organizationId,
            indexedDocumentId: candidate.id,
            retainUntil: deadline,
        });
    }
    const superseded = await tx.indexTask.findMany({
        where: {
            indexedDocumentId: candidate.id,
            kind: 'INDEX_DOCUMENT',
            status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        },
        select: { changeSequence: true },
    });
    for (const task of superseded)
        await acknowledgeGenerationChange(
            tx,
            candidate.generationId,
            task.changeSequence,
            'SUPERSEDED'
        );
    await tx.indexTask.updateMany({
        where: {
            indexedDocumentId: candidate.id,
            kind: 'INDEX_DOCUMENT',
            status: { in: ['PENDING', 'PROCESSING', 'FAILED'] },
        },
        data: {
            status: 'CANCELLED',
            stage: 'SUPERSEDED',
            leaseToken: null,
            leasedUntil: null,
        },
    });
    await tx.indexTask.upsert({
        where: {
            ['organizationId_dedupeKey']: {
                organizationId: candidate.organizationId,
                dedupeKey: `clean-publication:${candidate.id}`,
            },
        },
        create: {
            organizationId: candidate.organizationId,
            collectionId: candidate.collectionId,
            generationId: candidate.generationId,
            indexedDocumentId: candidate.id,
            kind: 'CLEAN_PUBLICATION',
            dedupeKey: `clean-publication:${candidate.id}`,
            requestedBy,
            availableAt: deadline,
        },
        update: {},
    });
}

/** A receipt advances only across contiguous committed acknowledgements, never over an incomplete earlier task. */
export async function acknowledgeGenerationChange(
    tx: Prisma.TransactionClient,
    generationId: string,
    sequence: bigint | null,
    effect: 'PUBLISHED' | 'REMOVED' | 'SUPERSEDED' | 'COLLECTION_DELETED'
) {
    if (sequence !== null)
        await tx.generationChange.updateMany({
            where: { generationId, sequence, status: 'PENDING' },
            data: { status: 'APPLIED', effect, appliedAt: new Date() },
        });
    const generation = await tx.indexGeneration.findUniqueOrThrow({
        where: { id: generationId },
    });
    const changes = await tx.generationChange.findMany({
        where: { generationId, sequence: { gt: generation.appliedSequence } },
        orderBy: { sequence: 'asc' },
        take: 100,
    });
    let through = generation.appliedSequence;
    for (const change of changes) {
        if (change.sequence !== through + 1n || change.status !== 'APPLIED')
            break;
        through = change.sequence;
    }
    if (through !== generation.appliedSequence)
        await tx.indexGeneration.update({
            where: { id: generationId },
            data: { appliedSequence: through },
        });
}

/** Publish only an immutable sealed manifest while the task lease and desired source are still current. */
export async function publishIndexedCandidate(
    tx: Prisma.TransactionClient,
    claim: IndexClaim,
    task: IndexTask,
    candidateId: string,
    manifestHash: string
) {
    await renewIndexClaim(tx, claim, 'PUBLISHING');
    const { candidate, desired, generation } = await requireCurrentCandidate(
        tx,
        claim,
        candidateId
    );
    if (
        candidate.materializedChunks !== candidate.chunkCount ||
        candidate.chunkCount < 1
    )
        throw new IndexingError('PROCESSING_FAILED');
    if (desired.publishedIndexedDocumentId === candidate.id) {
        await completeIndexClaim(tx, claim);
        return;
    }
    if (desired.publishedIndexedDocumentId) {
        const previous = await tx.indexedDocument.findUniqueOrThrow({
            where: { id: desired.publishedIndexedDocumentId },
        });
        await retireIndexedDocument(tx, previous, task.requestedBy);
    }
    if (generation.status === 'ACTIVE')
        await tx.collectionIndexAccounting.update({
            where: { collectionId: claim.collectionId },
            data: {
                retainedChunks: { decrement: candidate.materializedChunks },
                activeChunks: { increment: candidate.materializedChunks },
                revision: { increment: 1 },
            },
        });
    await tx.indexedDocument.update({
        where: { id: candidate.id },
        data: {
            status: 'PUBLISHED',
            manifestHash,
            vectorSealedAt: new Date(),
            publishedAt: new Date(),
        },
    });
    await tx.generationDocument.update({
        where: {
            ['generationId_documentId']: {
                generationId: claim.generationId,
                documentId: candidate.documentId,
            },
        },
        data: { publishedIndexedDocumentId: candidate.id, lastErrorCode: null },
    });
    await acknowledgeGenerationChange(
        tx,
        claim.generationId,
        task.changeSequence,
        'PUBLISHED'
    );
    await completeIndexClaim(tx, claim);
    await tx.ragAuditLog.create({
        data: {
            organizationId: claim.organizationId,
            actorType: 'worker',
            actorId: 'indexing',
            action: 'collection.document.indexed',
            targetId: candidate.documentId,
            details: {
                collectionId: claim.collectionId,
                generationId: claim.generationId,
                publicationId: candidate.id,
                chunks: candidate.chunkCount,
            },
        },
    });
}
