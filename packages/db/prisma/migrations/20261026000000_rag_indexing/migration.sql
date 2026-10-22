-- CreateEnum
CREATE TYPE "DocumentContentState" AS ENUM ('AVAILABLE', 'DELETING', 'PURGED');

-- CreateEnum
CREATE TYPE "RagContentLanguage" AS ENUM ('FR', 'EN', 'MIXED', 'UNDETERMINED');

-- CreateEnum
CREATE TYPE "IndexGenerationStatus" AS ENUM ('PROVISIONING', 'BUILDING', 'ACTIVE', 'FAILED', 'RETIRED', 'CLEANING', 'CLEANED');

-- CreateEnum
CREATE TYPE "IndexedDocumentStatus" AS ENUM ('STAGING', 'SEALED', 'PUBLISHED', 'RETIRED', 'CLEANING', 'CLEANED');

-- CreateEnum
CREATE TYPE "IndexTaskKind" AS ENUM ('PROVISION', 'INDEX_DOCUMENT', 'REMOVE_DOCUMENT', 'CLEAN_PUBLICATION', 'CLEAN_GENERATION');

-- CreateEnum
CREATE TYPE "IndexTaskStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CollectionChangeKind" AS ENUM ('UPSERT', 'REMOVE', 'COLLECTION_DELETE');

-- CreateEnum
CREATE TYPE "GenerationChangeStatus" AS ENUM ('PENDING', 'APPLIED');

-- CreateEnum
CREATE TYPE "GenerationChangeEffect" AS ENUM ('PUBLISHED', 'REMOVED', 'SUPERSEDED', 'COLLECTION_DELETED');

-- CreateEnum
CREATE TYPE "SourceHoldState" AS ENUM ('LIVE', 'RETIRED', 'RELEASED');

-- CreateEnum
CREATE TYPE "RagChunkKind" AS ENUM ('CHILD', 'PARENT');

-- AlterTable
ALTER TABLE "VectorConnection" ADD COLUMN     "destinationFingerprint" TEXT;

-- AlterTable
ALTER TABLE "Collection" ADD COLUMN     "activeGenerationId" TEXT,
ADD COLUMN     "contentSequence" BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "CollectionConfigRevision" ADD COLUMN     "embeddingPreset" TEXT NOT NULL DEFAULT 'GENERIC',
ADD COLUMN     "metadataFields" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "OrganizationQuota" ADD COLUMN     "temporaryChunksPerCollection" INTEGER NOT NULL DEFAULT 100000;

-- AlterTable
ALTER TABLE "DocumentVersion" ADD COLUMN     "contentFence" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "contentState" "DocumentContentState" NOT NULL DEFAULT 'AVAILABLE';

-- AlterTable
ALTER TABLE "DocumentExtraction" ADD COLUMN     "discardedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CollectionDocument" ADD COLUMN     "language" "RagContentLanguage" NOT NULL DEFAULT 'UNDETERMINED',
ADD COLUMN     "metadata" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "metadataRevision" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "IndexGeneration" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "configurationRevision" INTEGER NOT NULL,
    "vectorConnectionId" TEXT NOT NULL,
    "vectorSchema" VARCHAR(63) NOT NULL,
    "tableName" VARCHAR(63) NOT NULL,
    "destinationFingerprint" TEXT NOT NULL,
    "modelIdentity" TEXT NOT NULL,
    "capabilitySnapshot" JSONB NOT NULL,
    "chunkerVersion" TEXT NOT NULL,
    "status" "IndexGenerationStatus" NOT NULL DEFAULT 'PROVISIONING',
    "snapshotSequence" BIGINT NOT NULL DEFAULT 0,
    "appliedSequence" BIGINT NOT NULL DEFAULT 0,
    "projectedChunks" BIGINT NOT NULL DEFAULT 0,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),
    "cleanupAfter" TIMESTAMP(3),
    "lastErrorCode" TEXT,

    CONSTRAINT "IndexGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationDocument" (
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "desiredVersionId" TEXT,
    "desiredExtractionId" TEXT,
    "desiredMetadataRevision" INTEGER NOT NULL DEFAULT 0,
    "desiredChangeSequence" BIGINT NOT NULL DEFAULT 0,
    "buildRevision" INTEGER NOT NULL DEFAULT 0,
    "targetChunkCount" INTEGER NOT NULL DEFAULT 0,
    "publishedIndexedDocumentId" TEXT,
    "removedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GenerationDocument_pkey" PRIMARY KEY ("generationId","documentId")
);

-- CreateTable
CREATE TABLE "IndexedDocument" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sourceVersionId" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "buildRevision" INTEGER NOT NULL,
    "metadataRevision" INTEGER NOT NULL,
    "sourceChangeSequence" BIGINT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mediaType" TEXT NOT NULL,
    "language" "RagContentLanguage" NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "documentCreatedAt" TIMESTAMP(3) NOT NULL,
    "sourceCreatedAt" TIMESTAMP(3) NOT NULL,
    "status" "IndexedDocumentStatus" NOT NULL DEFAULT 'STAGING',
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "materializedChunks" INTEGER NOT NULL DEFAULT 0,
    "manifestHash" TEXT,
    "vectorSealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "retiredAt" TIMESTAMP(3),

    CONSTRAINT "IndexedDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Chunk" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "indexedDocumentId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "RagChunkKind" NOT NULL DEFAULT 'CHILD',
    "text" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "embeddingInputHash" TEXT NOT NULL,
    "sourceSpans" JSONB NOT NULL,
    "language" "RagContentLanguage" NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "tokenCountIsEstimate" BOOLEAN NOT NULL DEFAULT true,
    "parentId" TEXT,
    "lexicalFrench" tsvector NOT NULL DEFAULT ''::tsvector,
    "lexicalEnglish" tsvector NOT NULL DEFAULT ''::tsvector,
    "lexicalSimple" tsvector NOT NULL DEFAULT ''::tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Chunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IndexTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "indexedDocumentId" TEXT,
    "changeSequence" BIGINT,
    "kind" "IndexTaskKind" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "IndexTaskStatus" NOT NULL DEFAULT 'PENDING',
    "stage" TEXT NOT NULL DEFAULT 'ACCEPTED',
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leaseEpoch" BIGINT NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leasedUntil" TIMESTAMP(3),
    "reservedChunks" INTEGER NOT NULL DEFAULT 0,
    "completedChunks" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "IndexTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionChange" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "kind" "CollectionChangeKind" NOT NULL,
    "documentId" TEXT,
    "sourceVersionId" TEXT,
    "extractionId" TEXT,
    "metadataRevision" INTEGER,
    "language" "RagContentLanguage",
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchAttempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),
    "errorCode" TEXT,

    CONSTRAINT "CollectionChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GenerationChange" (
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "sequence" BIGINT NOT NULL,
    "status" "GenerationChangeStatus" NOT NULL DEFAULT 'PENDING',
    "effect" "GenerationChangeEffect",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "GenerationChange_pkey" PRIMARY KEY ("generationId","sequence")
);

-- CreateTable
CREATE TABLE "DocumentSourceHold" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "indexedDocumentId" TEXT NOT NULL,
    "state" "SourceHoldState" NOT NULL DEFAULT 'LIVE',
    "retainUntil" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentSourceHold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CollectionIndexAccounting" (
    "collectionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "activeChunks" BIGINT NOT NULL DEFAULT 0,
    "retainedChunks" BIGINT NOT NULL DEFAULT 0,
    "reservedChunks" BIGINT NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CollectionIndexAccounting_pkey" PRIMARY KEY ("collectionId")
);

-- CreateIndex
CREATE INDEX "IndexGeneration_organizationId_collectionId_status_idx" ON "IndexGeneration"("organizationId", "collectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IndexGeneration_organizationId_id_key" ON "IndexGeneration"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IndexGeneration_organizationId_collectionId_id_key" ON "IndexGeneration"("organizationId", "collectionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IndexGeneration_organizationId_requestId_key" ON "IndexGeneration"("organizationId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "IndexGeneration_vectorConnectionId_vectorSchema_tableName_key" ON "IndexGeneration"("vectorConnectionId", "vectorSchema", "tableName");

-- CreateIndex
CREATE INDEX "GenerationDocument_organizationId_documentId_idx" ON "GenerationDocument"("organizationId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationDocument_organizationId_generationId_documentId_key" ON "GenerationDocument"("organizationId", "generationId", "documentId");

-- CreateIndex
CREATE INDEX "IndexedDocument_organizationId_generationId_status_idx" ON "IndexedDocument"("organizationId", "generationId", "status");

-- CreateIndex
CREATE INDEX "IndexedDocument_organizationId_sourceVersionId_idx" ON "IndexedDocument"("organizationId", "sourceVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedDocument_organizationId_generationId_id_key" ON "IndexedDocument"("organizationId", "generationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedDocument_organizationId_generationId_documentId_id_key" ON "IndexedDocument"("organizationId", "generationId", "documentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedDocument_organizationId_sourceVersionId_id_key" ON "IndexedDocument"("organizationId", "sourceVersionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "IndexedDocument_organizationId_generationId_documentId_buil_key" ON "IndexedDocument"("organizationId", "generationId", "documentId", "buildRevision");

-- CreateIndex
CREATE INDEX "Chunk_organizationId_generationId_indexedDocumentId_idx" ON "Chunk"("organizationId", "generationId", "indexedDocumentId");

-- CreateIndex
CREATE INDEX "Chunk_lexicalFrench_idx" ON "Chunk" USING GIN ("lexicalFrench");

-- CreateIndex
CREATE INDEX "Chunk_lexicalEnglish_idx" ON "Chunk" USING GIN ("lexicalEnglish");

-- CreateIndex
CREATE INDEX "Chunk_lexicalSimple_idx" ON "Chunk" USING GIN ("lexicalSimple");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_organizationId_indexedDocumentId_id_key" ON "Chunk"("organizationId", "indexedDocumentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Chunk_indexedDocumentId_ordinal_key" ON "Chunk"("indexedDocumentId", "ordinal");

-- CreateIndex
CREATE INDEX "IndexTask_status_availableAt_leasedUntil_idx" ON "IndexTask"("status", "availableAt", "leasedUntil");

-- CreateIndex
CREATE INDEX "IndexTask_organizationId_collectionId_status_idx" ON "IndexTask"("organizationId", "collectionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IndexTask_organizationId_dedupeKey_key" ON "IndexTask"("organizationId", "dedupeKey");

-- CreateIndex
CREATE INDEX "CollectionChange_availableAt_dispatchedAt_idx" ON "CollectionChange"("availableAt", "dispatchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionChange_organizationId_collectionId_sequence_key" ON "CollectionChange"("organizationId", "collectionId", "sequence");

-- CreateIndex
CREATE INDEX "GenerationChange_organizationId_generationId_status_sequenc_idx" ON "GenerationChange"("organizationId", "generationId", "status", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "GenerationChange_organizationId_generationId_sequence_key" ON "GenerationChange"("organizationId", "generationId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSourceHold_indexedDocumentId_key" ON "DocumentSourceHold"("indexedDocumentId");

-- CreateIndex
CREATE INDEX "DocumentSourceHold_organizationId_versionId_state_retainUnt_idx" ON "DocumentSourceHold"("organizationId", "versionId", "state", "retainUntil");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSourceHold_organizationId_versionId_indexedDocument_key" ON "DocumentSourceHold"("organizationId", "versionId", "indexedDocumentId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionIndexAccounting_organizationId_collectionId_key" ON "CollectionIndexAccounting"("organizationId", "collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionConfigRevision_index_binding_key" ON "CollectionConfigRevision"("organizationId", "collectionId", "revision", "vectorConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentVersion_organizationId_documentId_id_key" ON "DocumentVersion"("organizationId", "documentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentExtraction_organizationId_versionId_id_key" ON "DocumentExtraction"("organizationId", "versionId", "id");

-- AddForeignKey
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_organizationId_collectionId_configurationR_fkey" FOREIGN KEY ("organizationId", "collectionId", "configurationRevision", "vectorConnectionId") REFERENCES "CollectionConfigRevision"("organizationId", "collectionId", "revision", "vectorConnectionId") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_organizationId_vectorConnectionId_fkey" FOREIGN KEY ("organizationId", "vectorConnectionId") REFERENCES "VectorConnection"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "GenerationDocument" ADD CONSTRAINT "GenerationDocument_organizationId_collectionId_generationI_fkey" FOREIGN KEY ("organizationId", "collectionId", "generationId") REFERENCES "IndexGeneration"("organizationId", "collectionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationDocument" ADD CONSTRAINT "GenerationDocument_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "GenerationDocument" ADD CONSTRAINT "GenerationDocument_organizationId_documentId_desiredVersio_fkey" FOREIGN KEY ("organizationId", "documentId", "desiredVersionId") REFERENCES "DocumentVersion"("organizationId", "documentId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "GenerationDocument" ADD CONSTRAINT "GenerationDocument_organizationId_desiredVersionId_desired_fkey" FOREIGN KEY ("organizationId", "desiredVersionId", "desiredExtractionId") REFERENCES "DocumentExtraction"("organizationId", "versionId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "GenerationDocument" ADD CONSTRAINT "GenerationDocument_organizationId_generationId_documentId__fkey" FOREIGN KEY ("organizationId", "generationId", "documentId", "publishedIndexedDocumentId") REFERENCES "IndexedDocument"("organizationId", "generationId", "documentId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "IndexedDocument" ADD CONSTRAINT "IndexedDocument_organizationId_collectionId_generationId_fkey" FOREIGN KEY ("organizationId", "collectionId", "generationId") REFERENCES "IndexGeneration"("organizationId", "collectionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexedDocument" ADD CONSTRAINT "IndexedDocument_organizationId_documentId_sourceVersionId_fkey" FOREIGN KEY ("organizationId", "documentId", "sourceVersionId") REFERENCES "DocumentVersion"("organizationId", "documentId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "IndexedDocument" ADD CONSTRAINT "IndexedDocument_organizationId_sourceVersionId_extractionI_fkey" FOREIGN KEY ("organizationId", "sourceVersionId", "extractionId") REFERENCES "DocumentExtraction"("organizationId", "versionId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_organizationId_generationId_indexedDocumentId_fkey" FOREIGN KEY ("organizationId", "generationId", "indexedDocumentId") REFERENCES "IndexedDocument"("organizationId", "generationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_organizationId_indexedDocumentId_parentId_fkey" FOREIGN KEY ("organizationId", "indexedDocumentId", "parentId") REFERENCES "Chunk"("organizationId", "indexedDocumentId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "IndexTask" ADD CONSTRAINT "IndexTask_organizationId_collectionId_generationId_fkey" FOREIGN KEY ("organizationId", "collectionId", "generationId") REFERENCES "IndexGeneration"("organizationId", "collectionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexTask" ADD CONSTRAINT "IndexTask_organizationId_generationId_indexedDocumentId_fkey" FOREIGN KEY ("organizationId", "generationId", "indexedDocumentId") REFERENCES "IndexedDocument"("organizationId", "generationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "IndexTask" ADD CONSTRAINT "IndexTask_organizationId_generationId_changeSequence_fkey" FOREIGN KEY ("organizationId", "generationId", "changeSequence") REFERENCES "GenerationChange"("organizationId", "generationId", "sequence") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "CollectionChange" ADD CONSTRAINT "CollectionChange_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionChange" ADD CONSTRAINT "CollectionChange_organizationId_documentId_fkey" FOREIGN KEY ("organizationId", "documentId") REFERENCES "Document"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "CollectionChange" ADD CONSTRAINT "CollectionChange_organizationId_documentId_sourceVersionId_fkey" FOREIGN KEY ("organizationId", "documentId", "sourceVersionId") REFERENCES "DocumentVersion"("organizationId", "documentId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "CollectionChange" ADD CONSTRAINT "CollectionChange_organizationId_sourceVersionId_extraction_fkey" FOREIGN KEY ("organizationId", "sourceVersionId", "extractionId") REFERENCES "DocumentExtraction"("organizationId", "versionId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "GenerationChange" ADD CONSTRAINT "GenerationChange_organizationId_collectionId_generationId_fkey" FOREIGN KEY ("organizationId", "collectionId", "generationId") REFERENCES "IndexGeneration"("organizationId", "collectionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GenerationChange" ADD CONSTRAINT "GenerationChange_organizationId_collectionId_sequence_fkey" FOREIGN KEY ("organizationId", "collectionId", "sequence") REFERENCES "CollectionChange"("organizationId", "collectionId", "sequence") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "DocumentSourceHold" ADD CONSTRAINT "DocumentSourceHold_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "DocumentVersion"("organizationId", "id") ON DELETE NO ACTION ON UPDATE CASCADE DEFERRABLE INITIALLY DEFERRED;

-- AddForeignKey
ALTER TABLE "DocumentSourceHold" ADD CONSTRAINT "DocumentSourceHold_organizationId_versionId_indexedDocumen_fkey" FOREIGN KEY ("organizationId", "versionId", "indexedDocumentId") REFERENCES "IndexedDocument"("organizationId", "sourceVersionId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionIndexAccounting" ADD CONSTRAINT "CollectionIndexAccounting_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Collection" ADD CONSTRAINT "Collection_organizationId_id_activeGenerationId_fkey" FOREIGN KEY ("organizationId", "id", "activeGenerationId") REFERENCES "IndexGeneration"("organizationId", "collectionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

-- Preserve historical purge state. New holds must never revive removed content.
UPDATE "DocumentVersion" SET "contentState" = 'PURGED' WHERE "discardedAt" IS NOT NULL;
UPDATE "DocumentExtraction" AS extraction SET "discardedAt" = version."discardedAt"
FROM "DocumentVersion" AS version
WHERE extraction."versionId" = version.id AND version."discardedAt" IS NOT NULL;

-- Prisma cannot express the full-text maintenance trigger or these cross-field
-- invariants. Text stays authoritative here; dynamic vectors live separately.
CREATE FUNCTION vectorix_chunk_lexical() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW."lexicalFrench" := to_tsvector('french'::regconfig, NEW.text);
    NEW."lexicalEnglish" := to_tsvector('english'::regconfig, NEW.text);
    NEW."lexicalSimple" := to_tsvector('simple'::regconfig, NEW.text);
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_chunk_lexical BEFORE INSERT OR UPDATE OF text ON "Chunk"
FOR EACH ROW EXECUTE FUNCTION vectorix_chunk_lexical();

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_content_sequence_check" CHECK ("contentSequence" >= 0);
ALTER TABLE "OrganizationQuota" ADD CONSTRAINT "OrganizationQuota_temporary_chunks_check" CHECK ("temporaryChunksPerCollection" BETWEEN 0 AND 100000000);
ALTER TABLE "DocumentVersion" ADD CONSTRAINT "DocumentVersion_content_fence_check" CHECK ("contentFence" >= 0);
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_progress_check" CHECK (
    "snapshotSequence" >= 0 AND "appliedSequence" >= "snapshotSequence" AND "projectedChunks" >= 0
);
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_generated_table_check" CHECK (
    "tableName" = 'g_' || replace(id, '-', '') AND "tableName" ~ '^g_[a-f0-9]{32}$'
    AND "vectorSchema" ~ '^[a-z_][a-z0-9_]{0,62}$'
);
CREATE UNIQUE INDEX "IndexGeneration_one_active_per_collection" ON "IndexGeneration" ("collectionId") WHERE status = 'ACTIVE';
ALTER TABLE "GenerationDocument" ADD CONSTRAINT "GenerationDocument_source_pair_check" CHECK (
    ("desiredVersionId" IS NULL) = ("desiredExtractionId" IS NULL)
    AND "desiredMetadataRevision" >= 0 AND "desiredChangeSequence" >= 0
    AND "buildRevision" >= 0 AND "targetChunkCount" >= 0
);
ALTER TABLE "IndexedDocument" ADD CONSTRAINT "IndexedDocument_chunk_count_check" CHECK (
    "chunkCount" >= 0 AND "materializedChunks" BETWEEN 0 AND "chunkCount" AND "buildRevision" > 0 AND "metadataRevision" > 0
);
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_position_check" CHECK (
    ordinal >= 0 AND "tokenCount" > 0 AND jsonb_typeof("sourceSpans") = 'array'
    AND jsonb_array_length("sourceSpans") BETWEEN 1 AND 5000 AND octet_length(text) <= 49152
);
ALTER TABLE "IndexTask" ADD CONSTRAINT "IndexTask_progress_check" CHECK (
    attempts >= 0 AND "leaseEpoch" >= 0 AND "reservedChunks" >= 0 AND "completedChunks" >= 0
    AND (("leaseToken" IS NULL) = ("leasedUntil" IS NULL))
    AND (kind NOT IN ('INDEX_DOCUMENT', 'CLEAN_PUBLICATION') OR "indexedDocumentId" IS NOT NULL)
);
ALTER TABLE "CollectionChange" ADD CONSTRAINT "CollectionChange_payload_check" CHECK (
    sequence > 0 AND (
        (kind = 'UPSERT' AND "documentId" IS NOT NULL AND "sourceVersionId" IS NOT NULL AND "extractionId" IS NOT NULL AND "metadataRevision" > 0 AND language IS NOT NULL)
        OR (kind = 'REMOVE' AND "documentId" IS NOT NULL AND "sourceVersionId" IS NULL AND "extractionId" IS NULL)
        OR (kind = 'COLLECTION_DELETE' AND "documentId" IS NULL AND "sourceVersionId" IS NULL AND "extractionId" IS NULL)
    )
);
ALTER TABLE "GenerationChange" ADD CONSTRAINT "GenerationChange_receipt_check" CHECK (
    sequence > 0 AND ((status = 'PENDING' AND effect IS NULL AND "appliedAt" IS NULL) OR (status = 'APPLIED' AND effect IS NOT NULL AND "appliedAt" IS NOT NULL))
);
ALTER TABLE "DocumentSourceHold" ADD CONSTRAINT "DocumentSourceHold_lifetime_check" CHECK (
    (state = 'LIVE' AND "retainUntil" IS NULL AND "releasedAt" IS NULL)
    OR (state = 'RETIRED' AND "retainUntil" IS NOT NULL AND "releasedAt" IS NULL)
    OR (state = 'RELEASED' AND "releasedAt" IS NOT NULL)
);
ALTER TABLE "CollectionIndexAccounting" ADD CONSTRAINT "CollectionIndexAccounting_nonnegative_check" CHECK (
    "activeChunks" >= 0 AND "retainedChunks" >= 0 AND "reservedChunks" >= 0 AND revision >= 0
);

-- Native organization deletion bypasses RAG handlers. A deleted organization
-- cannot discard the only cleanup binding for private objects or vector tables.
-- Descendant mutations take the same organization key-share lock, including
-- inserts below an existing Document/Collection, closing the admission/count race.
CREATE FUNCTION vectorix_rag_organization_lock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM id FROM organization WHERE id = NEW."organizationId" FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RAG organization no longer exists' USING ERRCODE = '23503';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_rag_document_org BEFORE INSERT OR UPDATE OF "organizationId" ON "Document"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_collection_org BEFORE INSERT OR UPDATE OF "organizationId" ON "Collection"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_version_org BEFORE INSERT OR UPDATE ON "DocumentVersion"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_generation_org BEFORE INSERT OR UPDATE ON "IndexGeneration"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_ingestion_org BEFORE INSERT OR UPDATE ON "DocumentIngestion"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_cleanup_org BEFORE INSERT OR UPDATE ON "DocumentCleanup"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();

CREATE FUNCTION vectorix_rag_organization_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "DocumentVersion" WHERE "organizationId" = OLD.id AND ("discardedAt" IS NULL OR "contentState" <> 'PURGED'))
        OR EXISTS (SELECT 1 FROM "DocumentIngestion" WHERE "organizationId" = OLD.id AND "reservedBytes" > 0)
        OR EXISTS (SELECT 1 FROM "DocumentCleanup" WHERE "organizationId" = OLD.id AND status <> 'COMPLETE')
        OR EXISTS (SELECT 1 FROM "IndexGeneration" WHERE "organizationId" = OLD.id AND status <> 'CLEANED') THEN
        RAISE EXCEPTION 'Delete RAG collections and documents, then wait for cleanup before deleting the organization'
            USING ERRCODE = '23514', CONSTRAINT = 'organization_rag_cleanup_required';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER vectorix_rag_organization_delete BEFORE DELETE ON organization
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_delete();
