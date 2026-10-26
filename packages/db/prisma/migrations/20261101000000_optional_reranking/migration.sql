-- CreateEnum
CREATE TYPE "RerankRequestState" AS ENUM ('ADMITTED', 'DISPATCHED', 'VALIDATED', 'FAILED', 'UNCERTAIN', 'SKIPPED');

-- CreateTable
CREATE TABLE "CollectionRerankConfig" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "provider" "CredentialProvider" NOT NULL,
    "model" TEXT NOT NULL,
    "candidatePool" INTEGER NOT NULL DEFAULT 50,
    "capabilityVersion" TEXT NOT NULL DEFAULT 'native-rerank-v1',
    "credentialId" TEXT,
    "credentialRevision" INTEGER,
    "endpoint" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CollectionRerankConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RerankRequest" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "collectionId" TEXT NOT NULL,
    "configurationId" TEXT NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "generationId" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "state" "RerankRequestState" NOT NULL DEFAULT 'ADMITTED',
    "admittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "dispatchedAt" TIMESTAMP(3),
    "dispatchDay" DATE,
    "completedAt" TIMESTAMP(3),
    "capacityReleasedAt" TIMESTAMP(3),
    "candidateCount" INTEGER NOT NULL DEFAULT 0,
    "preparedInputBytes" BIGINT NOT NULL DEFAULT 0,
    "providerInputTokens" BIGINT,
    "billedInputTokens" DOUBLE PRECISION,
    "billedSearchUnits" DOUBLE PRECISION,
    "nativeDurationMicros" BIGINT,
    "errorCode" TEXT,

    CONSTRAINT "RerankRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RerankUsageDay" (
    "organizationId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "dispatchedRequests" BIGINT NOT NULL DEFAULT 0,
    "dispatchedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "validatedRequests" BIGINT NOT NULL DEFAULT 0,
    "validatedDocuments" BIGINT NOT NULL DEFAULT 0,
    "knownProviderInputTokens" BIGINT NOT NULL DEFAULT 0,
    "unknownProviderInputTokenRequests" BIGINT NOT NULL DEFAULT 0,
    "knownBilledInputTokens" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unknownBilledInputTokenRequests" BIGINT NOT NULL DEFAULT 0,
    "knownBilledSearchUnits" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unknownBilledSearchUnitRequests" BIGINT NOT NULL DEFAULT 0,
    "observedNativeDurationMicros" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "RerankUsageDay_pkey" PRIMARY KEY ("organizationId","day","provider")
);

-- CreateTable
CREATE TABLE "OrganizationRerankAccounting" (
    "organizationId" TEXT NOT NULL,
    "lockRevision" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "OrganizationRerankAccounting_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRerankConfig_organizationId_collectionId_revision_key" ON "CollectionRerankConfig"("organizationId", "collectionId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "CollectionRerankConfig_organizationId_collectionId_id_key" ON "CollectionRerankConfig"("organizationId", "collectionId", "id");

-- CreateIndex
CREATE INDEX "RerankRequest_organizationId_state_expiresAt_idx" ON "RerankRequest"("organizationId", "state", "expiresAt");

-- CreateIndex
CREATE INDEX "RerankRequest_expiresAt_id_idx" ON "RerankRequest"("expiresAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RerankRequest_organizationId_principalId_requestId_key" ON "RerankRequest"("organizationId", "principalId", "requestId");

-- CreateIndex
CREATE INDEX "RerankUsageDay_day_idx" ON "RerankUsageDay"("day");

-- AddForeignKey
ALTER TABLE "CollectionRerankConfig" ADD CONSTRAINT "CollectionRerankConfig_organizationId_collectionId_fkey" FOREIGN KEY ("organizationId", "collectionId") REFERENCES "Collection"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CollectionRerankConfig" ADD CONSTRAINT "CollectionRerankConfig_organizationId_credentialId_provide_fkey" FOREIGN KEY ("organizationId", "credentialId", "provider") REFERENCES "Credentials"("organizationId", "id", "provider") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RerankRequest" ADD CONSTRAINT "RerankRequest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RerankUsageDay" ADD CONSTRAINT "RerankUsageDay_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationRerankAccounting" ADD CONSTRAINT "OrganizationRerankAccounting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reviewed domain guards that Prisma cannot express. Existing data is untouched.
ALTER TABLE "CollectionRerankConfig" ADD CONSTRAINT "rerank_config_valid" CHECK (
    "revision" >= 1 AND "candidatePool" BETWEEN 1 AND 100
    AND "capabilityVersion" = 'native-rerank-v1'
    AND (("provider" = 'COHERE' AND "model" IN ('rerank-v5.0-fast', 'rerank-v5.0-pro'))
      OR ("provider" = 'VOYAGE' AND "model" IN ('rerank-3', 'rerank-3-lite')))
    AND (("credentialId" IS NULL AND "credentialRevision" IS NULL)
      OR ("credentialId" IS NOT NULL AND "credentialRevision" IS NOT NULL AND "credentialRevision" >= 1))
    AND (NOT "enabled" OR "endpoint" IS NOT NULL)
    AND ("endpoint" IS NULL OR length("endpoint") BETWEEN 1 AND 2048)
);
ALTER TABLE "RerankRequest" ADD CONSTRAINT "rerank_request_valid" CHECK (
    "provider" IN ('COHERE', 'VOYAGE') AND length("principalId") BETWEEN 1 AND 512
    AND "requestId" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    AND "expiresAt" > "admittedAt"
    AND (("dispatchedAt" IS NULL AND "dispatchDay" IS NULL AND "candidateCount" = 0 AND "preparedInputBytes" = 0
         AND "providerInputTokens" IS NULL AND "billedInputTokens" IS NULL AND "billedSearchUnits" IS NULL AND "nativeDurationMicros" IS NULL)
      OR ("dispatchedAt" IS NOT NULL AND "dispatchDay" IS NOT NULL AND "candidateCount" BETWEEN 1 AND 100 AND "preparedInputBytes" BETWEEN 1 AND 512000))
    AND ("state" NOT IN ('DISPATCHED', 'VALIDATED', 'UNCERTAIN') OR "dispatchedAt" IS NOT NULL)
    AND ("state" IN ('ADMITTED', 'DISPATCHED') OR ("completedAt" IS NOT NULL AND "capacityReleasedAt" IS NOT NULL))
    AND ("state" <> 'ADMITTED' OR "dispatchedAt" IS NULL)
    AND ("state" <> 'SKIPPED' OR "dispatchedAt" IS NULL)
    AND ("state" <> 'VALIDATED' OR "nativeDurationMicros" IS NOT NULL)
    AND ("providerInputTokens" IS NULL OR "providerInputTokens" >= 0)
    AND ("nativeDurationMicros" IS NULL OR "nativeDurationMicros" >= 0)
    AND ("billedInputTokens" IS NULL OR ("billedInputTokens" >= 0 AND "billedInputTokens" < 'Infinity'::float8))
    AND ("billedSearchUnits" IS NULL OR ("billedSearchUnits" >= 0 AND "billedSearchUnits" < 'Infinity'::float8))
    AND ("errorCode" IS NULL OR "errorCode" ~ '^[A-Z_]{1,64}$')
);
ALTER TABLE "RerankUsageDay" ADD CONSTRAINT "rerank_usage_valid" CHECK (
    "provider" IN ('COHERE', 'VOYAGE')
    AND "dispatchedRequests" >= 0 AND "dispatchedPreparedBytes" >= 0
    AND "validatedRequests" >= 0 AND "validatedDocuments" >= 0
    AND "knownProviderInputTokens" >= 0 AND "unknownProviderInputTokenRequests" >= 0
    AND "unknownBilledInputTokenRequests" >= 0 AND "unknownBilledSearchUnitRequests" >= 0
    AND "observedNativeDurationMicros" >= 0
    AND "knownBilledInputTokens" >= 0 AND "knownBilledInputTokens" < 'Infinity'::float8
    AND "knownBilledSearchUnits" >= 0 AND "knownBilledSearchUnits" < 'Infinity'::float8
);
ALTER TABLE "OrganizationRerankAccounting" ADD CONSTRAINT "rerank_lock_valid" CHECK ("lockRevision" >= 0);

CREATE FUNCTION vectorix_rerank_config_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'Reranking configuration revisions are immutable' USING ERRCODE = '23514', CONSTRAINT = 'rerank_config_immutable';
END;
$$;
CREATE TRIGGER rerank_config_immutable BEFORE UPDATE ON "CollectionRerankConfig"
FOR EACH ROW EXECUTE FUNCTION vectorix_rerank_config_immutable();
