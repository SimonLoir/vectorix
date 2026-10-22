-- CreateEnum
CREATE TYPE "DocumentIngestionStatus" AS ENUM ('UPLOADING', 'PENDING', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "DocumentVersion" ADD COLUMN     "discardedAt" TIMESTAMP(3),
ADD COLUMN     "storedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DocumentIngestion" (
    "versionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "status" "DocumentIngestionStatus" NOT NULL DEFAULT 'UPLOADING',
    "reservedBytes" BIGINT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leasedUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentIngestion_pkey" PRIMARY KEY ("versionId")
);

-- CreateIndex
CREATE INDEX "DocumentIngestion_status_availableAt_idx" ON "DocumentIngestion"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestion_organizationId_requestId_key" ON "DocumentIngestion"("organizationId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentIngestion_organizationId_versionId_key" ON "DocumentIngestion"("organizationId", "versionId");

-- AddForeignKey
ALTER TABLE "DocumentIngestion" ADD CONSTRAINT "DocumentIngestion_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "DocumentVersion"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
