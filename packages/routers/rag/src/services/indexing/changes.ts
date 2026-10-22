import { randomUUID } from 'node:crypto';
import type {
    Prisma,
    IndexGeneration,
    CollectionDocument,
    Document,
    DocumentVersion,
    DocumentExtraction,
} from '@repo/db';
import { documentMetadata } from '@repo/api-contracts/v1/rag/indexing-types';
import { acquireSourceHold } from './source-holds';
import { indexError } from './errors';
import { retireIndexedDocument } from './publication-state';
import { projectMetadata } from './metadata-validation';

type ReadyVersion = DocumentVersion & { extraction: DocumentExtraction };
export interface DocumentSnapshot {
    document: Document;
    version: ReadyVersion;
    association: CollectionDocument;
}
const liveGenerations = [
    'PROVISIONING',
    'BUILDING',
    'ACTIVE',
    'FAILED',
] as const;

/** Immutable candidate fields shared by snapshot acceptance and later ordered changes. */
function candidateData(
    generation: IndexGeneration,
    source: DocumentSnapshot,
    buildRevision: number,
    sequence: bigint,
    fields: unknown
) {
    return {
        id: randomUUID(),
        organizationId: generation.organizationId,
        collectionId: generation.collectionId,
        generationId: generation.id,
        documentId: source.document.id,
        sourceVersionId: source.version.id,
        extractionId: source.version.extraction.id,
        extractorVersion: source.version.extraction.extractorVersion,
        buildRevision,
        metadataRevision: source.association.metadataRevision,
        sourceChangeSequence: sequence,
        fileName: source.version.fileName ?? source.document.name,
        mediaType: source.version.mediaType,
        language: source.association.language,
        tags: source.association.tags,
        metadata: projectMetadata(fields, source.association.metadata),
        documentCreatedAt: source.document.createdAt,
        sourceCreatedAt: source.version.createdAt,
    };
}

/**
 * Accept the bounded first-generation snapshot using batch ORM writes. Every
 * source fence is written before LIVE holds are created, so cleanup can win or
 * this snapshot can win, but no source is promised after deletion has started.
 */
export async function stageInitialSnapshot(
    tx: Prisma.TransactionClient,
    generation: IndexGeneration,
    documents: DocumentSnapshot[],
    requestedBy: string
) {
    if (!documents.length) return;
    const profile = await tx.collectionConfigRevision.findUniqueOrThrow({
        where: {
            ['organizationId_collectionId_revision']: {
                organizationId: generation.organizationId,
                collectionId: generation.collectionId,
                revision: generation.configurationRevision,
            },
        },
        select: { metadataFields: true },
    });
    const versionIds = [
        ...new Set(documents.map((source) => source.version.id)),
    ];
    const sources = await tx.documentVersion.updateMany({
        where: {
            organizationId: generation.organizationId,
            id: { in: versionIds },
            contentState: 'AVAILABLE',
            discardedAt: null,
        },
        data: { contentFence: { increment: 1 } },
    });
    if (sources.count !== versionIds.length)
        throw indexError('SOURCE_UNAVAILABLE');
    const candidates = documents.map((source) =>
        candidateData(
            generation,
            source,
            1,
            generation.snapshotSequence,
            profile.metadataFields
        )
    );
    await tx.generationDocument.createMany({
        data: documents.map((source) => ({
            organizationId: generation.organizationId,
            collectionId: generation.collectionId,
            generationId: generation.id,
            documentId: source.document.id,
            desiredVersionId: source.version.id,
            desiredExtractionId: source.version.extraction.id,
            desiredMetadataRevision: source.association.metadataRevision,
            desiredChangeSequence: generation.snapshotSequence,
            buildRevision: 1,
        })),
    });
    await tx.indexedDocument.createMany({ data: candidates });
    await tx.documentSourceHold.createMany({
        data: candidates.map((candidate) => ({
            organizationId: generation.organizationId,
            versionId: candidate.sourceVersionId,
            indexedDocumentId: candidate.id,
        })),
    });
    await tx.indexTask.createMany({
        data: candidates.map((candidate) => ({
            organizationId: generation.organizationId,
            collectionId: generation.collectionId,
            generationId: generation.id,
            indexedDocumentId: candidate.id,
            kind: 'INDEX_DOCUMENT' as const,
            dedupeKey: `index:${candidate.id}`,
            requestedBy,
        })),
    });
}

/** Stage a changed source and its hold in the same ordered transaction as its outbox event. */
async function stageChangedDocument(
    tx: Prisma.TransactionClient,
    generation: IndexGeneration,
    source: DocumentSnapshot,
    sequence: bigint,
    requestedBy: string
) {
    const profile = await tx.collectionConfigRevision.findUniqueOrThrow({
        where: {
            ['organizationId_collectionId_revision']: {
                organizationId: generation.organizationId,
                collectionId: generation.collectionId,
                revision: generation.configurationRevision,
            },
        },
        select: { metadataFields: true },
    });
    const desired = await tx.generationDocument.upsert({
        where: {
            ['generationId_documentId']: {
                generationId: generation.id,
                documentId: source.document.id,
            },
        },
        create: {
            organizationId: generation.organizationId,
            collectionId: generation.collectionId,
            generationId: generation.id,
            documentId: source.document.id,
            desiredVersionId: source.version.id,
            desiredExtractionId: source.version.extraction.id,
            desiredMetadataRevision: source.association.metadataRevision,
            desiredChangeSequence: sequence,
            buildRevision: 1,
        },
        update: {
            desiredVersionId: source.version.id,
            desiredExtractionId: source.version.extraction.id,
            desiredMetadataRevision: source.association.metadataRevision,
            desiredChangeSequence: sequence,
            buildRevision: { increment: 1 },
            removedAt: null,
            lastErrorCode: null,
        },
    });
    const superseded = await tx.indexedDocument.findMany({
        where: {
            organizationId: generation.organizationId,
            generationId: generation.id,
            documentId: source.document.id,
            status: { in: ['STAGING', 'SEALED'] },
        },
    });
    for (const candidate of superseded)
        await retireIndexedDocument(tx, candidate, requestedBy, true);
    const candidate = await tx.indexedDocument.create({
        data: candidateData(
            generation,
            source,
            desired.buildRevision,
            sequence,
            profile.metadataFields
        ),
    });
    if (
        !(await acquireSourceHold(tx, {
            organizationId: generation.organizationId,
            versionId: source.version.id,
            indexedDocumentId: candidate.id,
        }))
    )
        throw indexError('SOURCE_UNAVAILABLE');
    await tx.indexTask.create({
        data: {
            organizationId: generation.organizationId,
            collectionId: generation.collectionId,
            generationId: generation.id,
            indexedDocumentId: candidate.id,
            changeSequence: sequence,
            kind: 'INDEX_DOCUMENT',
            dedupeKey: `index:${candidate.id}`,
            // The accepted rebuild owns its full catch-up snapshot. A library
            // writer can replace a shared source without administering every
            // linked collection; recheck B's durable controller instead.
            requestedBy:
                generation.previousGenerationId &&
                ['PROVISIONING', 'BUILDING', 'FAILED'].includes(generation.status)
                    ? generation.authorityUserId ?? generation.createdBy
                    : requestedBy,
        },
    });
}

/** Resolve one exact published source and validated collection metadata without private object I/O. */
export async function currentDocumentSnapshot(
    tx: Prisma.TransactionClient,
    organizationId: string,
    collectionId: string,
    documentId: string
): Promise<DocumentSnapshot | null> {
    const association = await tx.collectionDocument.findFirst({
        where: { organizationId, collectionId, documentId },
        include: { document: true },
    });
    if (!association || association.document.deletedAt) return null;
    const version = await tx.documentVersion.findFirst({
        where: {
            organizationId,
            documentId,
            status: 'READY',
            contentState: 'AVAILABLE',
            discardedAt: null,
            extraction: { discardedAt: null },
        },
        orderBy: { version: 'desc' },
        include: { extraction: true },
    });
    if (!version?.extraction) return null;
    return {
        association,
        document: association.document,
        version: { ...version, extraction: version.extraction },
    };
}

/**
 * Allocate events under a collection row write inside the caller's serializable
 * mutation. The snapshot, exact source holds, task acceptance and audit commit
 * together; Redis never decides whether a change exists.
 */
export async function recordDocumentChange(
    tx: Prisma.TransactionClient,
    input: {
        organizationId: string;
        collectionId: string;
        documentId: string;
        kind: 'UPSERT' | 'REMOVE';
        requestedBy: string;
    }
) {
    const collection = await tx.collection.update({
        where: {
            ['organizationId_id']: {
                organizationId: input.organizationId,
                id: input.collectionId,
            },
        },
        data: { contentSequence: { increment: 1 } },
    });
    const sequence = collection.contentSequence;
    const snapshot =
        input.kind === 'UPSERT'
            ? await currentDocumentSnapshot(
                  tx,
                  input.organizationId,
                  input.collectionId,
                  input.documentId
              )
            : null;
    if (input.kind === 'UPSERT' && !snapshot)
        throw indexError('SOURCE_UNAVAILABLE');
    await tx.collectionChange.create({
        data: {
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            sequence,
            dispatchedAt: new Date(),
            kind: input.kind,
            documentId: input.documentId,
            ...(snapshot
                ? {
                      sourceVersionId: snapshot.version.id,
                      extractionId: snapshot.version.extraction.id,
                      metadataRevision: snapshot.association.metadataRevision,
                      language: snapshot.association.language,
                      tags: snapshot.association.tags,
                      metadata: documentMetadata.parse(
                          snapshot.association.metadata
                      ),
                  }
                : {}),
        },
    });
    const generations = await tx.indexGeneration.findMany({
        where: {
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            status: { in: [...liveGenerations] },
        },
    });
    for (const generation of generations) {
        await tx.generationChange.create({
            data: {
                organizationId: input.organizationId,
                collectionId: input.collectionId,
                generationId: generation.id,
                sequence,
            },
        });
        if (snapshot)
            await stageChangedDocument(
                tx,
                generation,
                snapshot,
                sequence,
                input.requestedBy
            );
        else {
            await tx.generationDocument.updateMany({
                where: {
                    organizationId: input.organizationId,
                    generationId: generation.id,
                    documentId: input.documentId,
                },
                data: {
                    desiredVersionId: null,
                    desiredExtractionId: null,
                    desiredChangeSequence: sequence,
                    desiredMetadataRevision: 0,
                    removedAt: new Date(),
                    buildRevision: { increment: 1 },
                    lastErrorCode: null,
                },
            });
            const superseded = await tx.indexedDocument.findMany({
                where: {
                    organizationId: input.organizationId,
                    generationId: generation.id,
                    documentId: input.documentId,
                    status: { in: ['STAGING', 'SEALED'] },
                },
            });
            for (const candidate of superseded)
                await retireIndexedDocument(
                    tx,
                    candidate,
                    input.requestedBy,
                    true
                );
            await tx.indexTask.create({
                data: {
                    organizationId: input.organizationId,
                    collectionId: input.collectionId,
                    generationId: generation.id,
                    changeSequence: sequence,
                    kind: 'REMOVE_DOCUMENT',
                    dedupeKey: `remove:${generation.id}:${sequence}`,
                    requestedBy: input.requestedBy,
                },
            });
        }
    }
    return sequence;
}

/** A newly published library version fans out to linked collections in deterministic lock order. */
export async function publishDocumentChanges(
    tx: Prisma.TransactionClient,
    input: { organizationId: string; documentId: string; requestedBy: string }
) {
    const links = await tx.collectionDocument.findMany({
        where: {
            organizationId: input.organizationId,
            documentId: input.documentId,
            collection: { deletedAt: null },
        },
        orderBy: { collectionId: 'asc' },
        select: { collectionId: true },
    });
    for (const link of links)
        await recordDocumentChange(tx, {
            ...input,
            collectionId: link.collectionId,
            kind: 'UPSERT',
        });
}

/** Accepted collection deletion remains durable after grants/membership disappear. */
export async function recordCollectionDeletion(
    tx: Prisma.TransactionClient,
    input: { organizationId: string; collectionId: string; requestedBy: string }
) {
    const collection = await tx.collection.update({
        where: {
            ['organizationId_id']: {
                organizationId: input.organizationId,
                id: input.collectionId,
            },
        },
        data: { contentSequence: { increment: 1 } },
    });
    const sequence = collection.contentSequence;
    await tx.collectionChange.create({
        data: {
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            sequence,
            dispatchedAt: new Date(),
            kind: 'COLLECTION_DELETE',
        },
    });
    const generations = await tx.indexGeneration.findMany({
        where: {
            organizationId: input.organizationId,
            collectionId: input.collectionId,
            status: { not: 'CLEANED' },
        },
    });
    for (const generation of generations) {
        await tx.generationChange.create({
            data: {
                organizationId: input.organizationId,
                collectionId: input.collectionId,
                generationId: generation.id,
                sequence,
            },
        });
        await tx.indexTask.upsert({
            where: {
                ['organizationId_dedupeKey']: {
                    organizationId: input.organizationId,
                    dedupeKey: `clean-generation:${generation.id}`,
                },
            },
            create: {
                organizationId: input.organizationId,
                collectionId: input.collectionId,
                generationId: generation.id,
                kind: 'CLEAN_GENERATION',
                changeSequence: sequence,
                dedupeKey: `clean-generation:${generation.id}`,
                requestedBy: input.requestedBy,
            },
            update: {},
        });
    }
}
