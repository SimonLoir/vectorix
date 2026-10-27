-- AlterTable
ALTER TABLE "CollectionRerankConfig" ADD COLUMN     "runtimeSnapshot" JSONB,
ADD COLUMN     "selfHostedCredentialId" TEXT;

-- CreateTable
CREATE TABLE "RerankEndpointCredential" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "provider" "CredentialProvider" NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "endpoint" TEXT NOT NULL,
    "apiKey" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RerankEndpointCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RerankEndpointCredential_organizationId_createdAt_id_idx" ON "RerankEndpointCredential"("organizationId", "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "RerankEndpointCredential_organizationId_id_provider_key" ON "RerankEndpointCredential"("organizationId", "id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "RerankEndpointCredential_organizationId_provider_name_key" ON "RerankEndpointCredential"("organizationId", "provider", "name");

-- AddForeignKey
ALTER TABLE "CollectionRerankConfig" ADD CONSTRAINT "CollectionRerankConfig_organizationId_selfHostedCredential_fkey" FOREIGN KEY ("organizationId", "selfHostedCredentialId", "provider") REFERENCES "RerankEndpointCredential"("organizationId", "id", "provider") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RerankEndpointCredential" ADD CONSTRAINT "RerankEndpointCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preserve retained bindings through native organization deletion transactions.
ALTER TABLE "CollectionRerankConfig" ALTER CONSTRAINT "CollectionRerankConfig_organizationId_selfHostedCredential_fkey" DEFERRABLE INITIALLY DEFERRED;

-- One organization selection; inactive rows remain valid saved bindings.
CREATE UNIQUE INDEX "rerank_endpoint_one_active" ON "RerankEndpointCredential" ("organizationId", "provider") WHERE "active";
ALTER TABLE "RerankEndpointCredential" ADD CONSTRAINT "rerank_endpoint_valid" CHECK (
    "provider" = 'TEI' AND "revision" >= 1
    AND length("name") BETWEEN 1 AND 100 AND btrim("name") = "name"
    AND length("endpoint") BETWEEN 1 AND 2048
    AND "endpoint" ~ '^https?://[^/?#@[:cntrl:]]+/?$'
    AND ("apiKey" IS NULL OR octet_length("apiKey") BETWEEN 1 AND 131072)
);

-- CHECK must reject SQL NULL/JSON null/missing or unknown keys, not pass UNKNOWN.
-- Snapshot fields are endpoint-reported capabilities, never verified weight digests.
ALTER TABLE "CollectionRerankConfig" DROP CONSTRAINT "rerank_config_valid";
ALTER TABLE "CollectionRerankConfig" ADD CONSTRAINT "rerank_config_valid" CHECK (
    COALESCE(
        "revision" >= 1 AND "candidatePool" BETWEEN 1 AND 100
        AND ("endpoint" IS NULL OR length("endpoint") BETWEEN 1 AND 2048)
        AND (NOT "enabled" OR "endpoint" IS NOT NULL)
        AND (
            (
                "provider" IN ('COHERE', 'VOYAGE')
                AND "capabilityVersion" = 'native-rerank-v1'
                AND (("provider" = 'COHERE' AND "model" IN ('rerank-v5.0-fast', 'rerank-v5.0-pro'))
                  OR ("provider" = 'VOYAGE' AND "model" IN ('rerank-3', 'rerank-3-lite')))
                AND "selfHostedCredentialId" IS NULL AND "runtimeSnapshot" IS NULL
                AND (("credentialId" IS NULL AND "credentialRevision" IS NULL)
                  OR ("credentialId" IS NOT NULL AND "credentialRevision" >= 1))
            )
            OR (
                "provider" = 'TEI' AND "capabilityVersion" = 'native-tei-v1'
                -- Match native bounded labels, including local paths and version suffixes.
                -- PostgreSQL text excludes NUL; the remaining exclusions match JS whitespace/C0/DEL.
                AND length("model") BETWEEN 1 AND 200
                AND "model" !~ U&'[\0001-\0020\007F\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]'
                AND "credentialId" IS NULL
                AND (("selfHostedCredentialId" IS NULL AND "credentialRevision" IS NULL)
                  OR ("selfHostedCredentialId" IS NOT NULL AND "credentialRevision" >= 1))
                AND ((NOT "enabled" AND "runtimeSnapshot" IS NULL) OR (
                    "enabled" AND "runtimeSnapshot" IS NOT NULL
                    AND jsonb_typeof("runtimeSnapshot") = 'object'
                    AND "runtimeSnapshot" ?& ARRAY['protocolVersion','modelId','modelRevision','modelType','maxInputLength','maxClientBatchSize','runtimeVersion','modelDtype']
                    AND "runtimeSnapshot" - ARRAY['protocolVersion','modelId','modelRevision','modelType','maxInputLength','maxClientBatchSize','runtimeVersion','modelDtype'] = '{}'::jsonb
                    AND "runtimeSnapshot"->>'protocolVersion' = 'native-tei-v1'
                    AND "runtimeSnapshot"->>'modelType' = 'reranker'
                    AND jsonb_typeof("runtimeSnapshot"->'modelId') = 'string'
                    AND "runtimeSnapshot"->>'modelId' = "model"
                    AND (jsonb_typeof("runtimeSnapshot"->'modelRevision') = 'null' OR (
                        jsonb_typeof("runtimeSnapshot"->'modelRevision') = 'string'
                        AND length("runtimeSnapshot"->>'modelRevision') BETWEEN 1 AND 128))
                    AND jsonb_typeof("runtimeSnapshot"->'runtimeVersion') = 'string'
                    AND length("runtimeSnapshot"->>'runtimeVersion') BETWEEN 1 AND 64
                    AND jsonb_typeof("runtimeSnapshot"->'modelDtype') = 'string'
                    AND length("runtimeSnapshot"->>'modelDtype') BETWEEN 1 AND 64
                    AND CASE WHEN jsonb_typeof("runtimeSnapshot"->'maxInputLength') = 'number'
                        AND "runtimeSnapshot"->>'maxInputLength' ~ '^[1-9][0-9]{0,7}$'
                        THEN ("runtimeSnapshot"->>'maxInputLength')::numeric BETWEEN 1 AND 10000000 ELSE false END
                    AND CASE WHEN jsonb_typeof("runtimeSnapshot"->'maxClientBatchSize') = 'number'
                        AND "runtimeSnapshot"->>'maxClientBatchSize' ~ '^[1-9][0-9]{0,5}$'
                        THEN ("runtimeSnapshot"->>'maxClientBatchSize')::numeric BETWEEN "candidatePool" AND 100000 ELSE false END
                ))
            )
        ), false
    )
);

ALTER TABLE "RerankRequest" DROP CONSTRAINT "rerank_request_valid";
ALTER TABLE "RerankRequest" ADD CONSTRAINT "rerank_request_valid" CHECK (
    "provider" IN ('COHERE', 'VOYAGE', 'TEI') AND length("principalId") BETWEEN 1 AND 512
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

ALTER TABLE "RerankUsageDay" DROP CONSTRAINT "rerank_usage_valid";
ALTER TABLE "RerankUsageDay" ADD CONSTRAINT "rerank_usage_valid" CHECK (
    "provider" IN ('COHERE', 'VOYAGE', 'TEI')
    AND "dispatchedRequests" >= 0 AND "dispatchedPreparedBytes" >= 0
    AND "validatedRequests" >= 0 AND "validatedDocuments" >= 0
    AND "knownProviderInputTokens" >= 0 AND "unknownProviderInputTokenRequests" >= 0
    AND "unknownBilledInputTokenRequests" >= 0 AND "unknownBilledSearchUnitRequests" >= 0
    AND "observedNativeDurationMicros" >= 0
    AND "knownBilledInputTokens" >= 0 AND "knownBilledInputTokens" < 'Infinity'::float8
    AND "knownBilledSearchUnits" >= 0 AND "knownBilledSearchUnits" < 'Infinity'::float8
);
