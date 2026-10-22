-- AlterTable
ALTER TABLE "IndexGeneration" ADD COLUMN     "previousGenerationId" TEXT,
ADD COLUMN     "authorityUserId" TEXT;

-- CreateIndex
CREATE INDEX "IndexGeneration_organizationId_collectionId_previousGenerat_idx" ON "IndexGeneration"("organizationId", "collectionId", "previousGenerationId");

-- AddForeignKey
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_organizationId_collectionId_previousGenera_fkey" FOREIGN KEY ("organizationId", "collectionId", "previousGenerationId") REFERENCES "IndexGeneration"("organizationId", "collectionId", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Retain immutable lineage without preventing a fully cleaned organization's
-- metadata cascade. Prisma cannot express deferrable or partial constraints.
ALTER TABLE "IndexGeneration"
    ALTER CONSTRAINT "IndexGeneration_organizationId_collectionId_previousGenera_fkey"
    DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "IndexGeneration"
    ADD CONSTRAINT "IndexGeneration_predecessor_not_self"
    CHECK ("previousGenerationId" IS NULL OR "previousGenerationId" <> "id");

CREATE UNIQUE INDEX "IndexGeneration_one_candidate_per_collection"
    ON "IndexGeneration" ("collectionId")
    WHERE "status" IN ('PROVISIONING', 'BUILDING', 'FAILED');

CREATE UNIQUE INDEX "IndexGeneration_one_rebuild_per_organization"
    ON "IndexGeneration" ("organizationId")
    WHERE "previousGenerationId" IS NOT NULL
        AND "status" IN ('PROVISIONING', 'BUILDING', 'FAILED');
