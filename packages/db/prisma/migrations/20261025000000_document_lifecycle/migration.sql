-- CreateEnum
CREATE TYPE "DocumentCleanupStatus" AS ENUM ('PENDING', 'PROCESSING', 'FAILED', 'COMPLETE');

-- AlterTable
ALTER TABLE "DocumentVersion" ADD COLUMN     "fileName" TEXT;

-- CreateTable
CREATE TABLE "DocumentCleanup" (
    "versionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "DocumentCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "availableAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "leasedUntil" TIMESTAMP(3),
    "leaseToken" TEXT,
    "errorCode" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentCleanup_pkey" PRIMARY KEY ("versionId")
);

-- CreateIndex
CREATE INDEX "DocumentCleanup_status_availableAt_idx" ON "DocumentCleanup"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentCleanup_organizationId_versionId_key" ON "DocumentCleanup"("organizationId", "versionId");

-- AddForeignKey
ALTER TABLE "DocumentCleanup" ADD CONSTRAINT "DocumentCleanup_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "DocumentVersion"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
