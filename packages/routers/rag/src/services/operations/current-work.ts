import { Prisma } from '@repo/db';
import type { OperationCategory } from './types';

function liveGeneration() {
    return Prisma.sql`target."deletedAt" IS NULL AND (
        (generation.status='ACTIVE' AND target."activeGenerationId"=generation.id)
        OR (generation.status IN ('PROVISIONING','BUILDING','FAILED')
            AND generation."previousGenerationId" IS NOT DISTINCT FROM target."activeGenerationId")
    )`;
}

function currentCandidate() {
    return Prisma.sql`candidate.status IN ('STAGING','SEALED','PUBLISHED') AND EXISTS (
        SELECT 1 FROM "GenerationDocument" desired
        JOIN "Document" document ON document."organizationId"=desired."organizationId"
            AND document.id=desired."documentId" AND document."deletedAt" IS NULL
        JOIN "CollectionDocument" association ON association."organizationId"=desired."organizationId"
            AND association."collectionId"=desired."collectionId" AND association."documentId"=desired."documentId"
        WHERE desired."organizationId"=task."organizationId" AND desired."collectionId"=task."collectionId"
            AND desired."generationId"=task."generationId" AND desired."documentId"=candidate."documentId"
            AND desired."removedAt" IS NULL AND desired."buildRevision"=candidate."buildRevision"
            AND desired."desiredVersionId"=candidate."sourceVersionId"
            AND desired."desiredExtractionId"=candidate."extractionId"
            AND desired."desiredMetadataRevision"=candidate."metadataRevision"
            AND desired."desiredChangeSequence"=candidate."sourceChangeSequence"
            AND association."metadataRevision"=candidate."metadataRevision"
    )`;
}

function currentRemoval() {
    return Prisma.sql`generation.status<>'CLEANED' AND EXISTS (
        SELECT 1 FROM "GenerationChange" receipt
        JOIN "CollectionChange" change ON change."organizationId"=receipt."organizationId"
            AND change."collectionId"=receipt."collectionId" AND change.sequence=receipt.sequence
        JOIN "GenerationDocument" desired ON desired."organizationId"=receipt."organizationId"
            AND desired."generationId"=receipt."generationId" AND desired."collectionId"=receipt."collectionId"
            AND desired."documentId"=change."documentId"
        WHERE receipt."organizationId"=task."organizationId" AND receipt."collectionId"=task."collectionId"
            AND receipt."generationId"=task."generationId" AND receipt.sequence=task."changeSequence"
            AND receipt.status='PENDING' AND change.kind='REMOVE' AND desired."removedAt" IS NOT NULL
            AND desired."desiredChangeSequence"=task."changeSequence"
    )`;
}

/** Exact related-column comparisons cannot be expressed by Prisma relation filters. */
export function categorySource(category: OperationCategory) {
    if (category !== 'INDEXING') {
        const table =
            category === 'INGESTION'
                ? Prisma.sql`"DocumentIngestion"`
                : Prisma.sql`"DocumentCleanup"`;
        return Prisma.sql`${table} task
            JOIN "DocumentVersion" version ON version."organizationId"=task."organizationId" AND version.id=task."versionId"
            JOIN "Document" target ON target."organizationId"=version."organizationId" AND target.id=version."documentId"`;
    }
    return Prisma.sql`"IndexTask" task
        JOIN "IndexGeneration" generation ON generation."organizationId"=task."organizationId"
            AND generation."collectionId"=task."collectionId" AND generation.id=task."generationId"
        JOIN "Collection" target ON target."organizationId"=task."organizationId" AND target.id=task."collectionId"
        LEFT JOIN "IndexedDocument" candidate ON candidate."organizationId"=task."organizationId"
            AND candidate."generationId"=task."generationId" AND candidate.id=task."indexedDocumentId"`;
}

/** Accepted destructive work is independent of cost-work desired tuples and may have no candidate. */
export function currentWork(category: OperationCategory) {
    if (category === 'DOCUMENT_CLEANUP')
        return Prisma.sql`task.status IN ('PENDING','PROCESSING','FAILED')`;
    if (category === 'INGESTION')
        return Prisma.sql`task.status IN ('UPLOADING','PENDING','PROCESSING','FAILED')
            AND target."deletedAt" IS NULL AND version."discardedAt" IS NULL AND version."contentState"='AVAILABLE'
            AND NOT EXISTS (SELECT 1 FROM "DocumentVersion" newer
                WHERE newer."organizationId"=version."organizationId" AND newer."documentId"=version."documentId"
                    AND newer.version>version.version)`;
    return Prisma.sql`task.status IN ('PENDING','PROCESSING','FAILED') AND (
        (task.kind='PROVISION' AND task."indexedDocumentId" IS NULL AND generation.status<>'ACTIVE' AND ${liveGeneration()})
        OR (task.kind='INDEX_DOCUMENT' AND ${liveGeneration()} AND ${currentCandidate()})
        OR (task.kind='REMOVE_DOCUMENT' AND ${currentRemoval()})
        OR (task.kind='CLEAN_PUBLICATION' AND candidate.status IN ('RETIRED','CLEANING'))
        OR (task.kind='CLEAN_GENERATION' AND (generation.status IN ('RETIRED','CLEANING')
            OR (target."deletedAt" IS NOT NULL AND generation.status<>'CLEANED')))
    )`;
}
