-- CreateEnum
CREATE TYPE "SemanticChunkPlanState" AS ENUM ('PLANNING', 'READY', 'CLEANED');

-- CreateEnum
CREATE TYPE "EmbeddingWorkPurpose" AS ENUM ('BOUNDARY', 'FINAL_DOCUMENT');

-- CreateEnum
CREATE TYPE "EmbeddingWorkState" AS ENUM ('RESERVED', 'IN_FLIGHT', 'SUCCEEDED', 'FAILED', 'UNCERTAIN', 'CANCELLED');

-- AlterTable
ALTER TABLE "IndexTask" ADD COLUMN     "continuationPending" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "continuations" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrganizationQuota" ADD COLUMN     "embeddingBatchesPerCandidate" INTEGER NOT NULL DEFAULT 4096,
ADD COLUMN     "embeddingOutstandingBatches" INTEGER NOT NULL DEFAULT 16384,
ADD COLUMN     "embeddingOutstandingPreparedBytes" BIGINT NOT NULL DEFAULT 536870912,
ADD COLUMN     "embeddingPreparedBytesPerCandidate" BIGINT NOT NULL DEFAULT 134217728,
ADD COLUMN     "semanticPlanBytesPerDocument" INTEGER NOT NULL DEFAULT 1048576,
ADD COLUMN     "semanticPlanBytesPerOrganization" BIGINT NOT NULL DEFAULT 67108864,
ADD COLUMN     "semanticUnitsPerDocument" INTEGER NOT NULL DEFAULT 8192;

-- CreateTable
CREATE TABLE "SemanticChunkPlan" (
    "indexedDocumentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "configurationRevision" INTEGER NOT NULL,
    "chunkerVersion" TEXT NOT NULL,
    "unitizerVersion" TEXT NOT NULL,
    "sourceHash" VARCHAR(64) NOT NULL,
    "profileHash" VARCHAR(64) NOT NULL,
    "modelIdentity" TEXT NOT NULL,
    "unitManifestHash" VARCHAR(64) NOT NULL,
    "unitCount" INTEGER NOT NULL,
    "unitRanges" JSONB NOT NULL,
    "completedUnits" INTEGER NOT NULL DEFAULT 0,
    "boundaryScores" JSONB NOT NULL DEFAULT '[]',
    "lastUnitVector" BYTEA,
    "state" "SemanticChunkPlanState" NOT NULL DEFAULT 'PLANNING',
    "thresholdDistance" INTEGER,
    "finalRanges" JSONB,
    "planHash" VARCHAR(64),
    "reservedBytes" BIGINT NOT NULL DEFAULT 0,
    "storedBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedBatches" INTEGER NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sealedAt" TIMESTAMP(3),
    "cleanedAt" TIMESTAMP(3),

    CONSTRAINT "SemanticChunkPlan_pkey" PRIMARY KEY ("indexedDocumentId")
);

-- CreateTable
CREATE TABLE "EmbeddingWorkAttempt" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "generationId" TEXT NOT NULL,
    "indexedDocumentId" TEXT NOT NULL,
    "purpose" "EmbeddingWorkPurpose" NOT NULL,
    "operationKey" VARCHAR(128) NOT NULL,
    "batchOrdinal" INTEGER NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "inputHash" VARCHAR(64) NOT NULL,
    "inputCount" INTEGER NOT NULL,
    "preparedInputBytes" INTEGER NOT NULL,
    "taskId" TEXT NOT NULL,
    "leaseEpoch" BIGINT NOT NULL,
    "state" "EmbeddingWorkState" NOT NULL DEFAULT 'RESERVED',
    "reservedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedBatches" INTEGER NOT NULL DEFAULT 0,
    "dispatchedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "dispatchedBatches" INTEGER NOT NULL DEFAULT 0,
    "successfulRequests" INTEGER,
    "estimatedInputTokens" BIGINT,
    "providerInputTokens" BIGINT,
    "billedInputTokens" DOUBLE PRECISION,
    "outcomeCode" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "dispatchStartedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "settledAt" TIMESTAMP(3),
    "usageRecordedAt" TIMESTAMP(3),
    "uncertainAt" TIMESTAMP(3),

    CONSTRAINT "EmbeddingWorkAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationEmbeddingAccounting" (
    "organizationId" TEXT NOT NULL,
    "reservedPlanBytes" BIGINT NOT NULL DEFAULT 0,
    "storedPlanBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "reservedBatches" BIGINT NOT NULL DEFAULT 0,
    "dispatchedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "dispatchedBatches" BIGINT NOT NULL DEFAULT 0,
    "observedSuccessfulRequests" BIGINT NOT NULL DEFAULT 0,
    "observedEstimatedInputTokens" BIGINT NOT NULL DEFAULT 0,
    "observedProviderInputTokens" BIGINT NOT NULL DEFAULT 0,
    "observedBilledInputTokens" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unknownProviderTokenBatches" BIGINT NOT NULL DEFAULT 0,
    "unknownBilledTokenBatches" BIGINT NOT NULL DEFAULT 0,
    "uncertainAttempts" BIGINT NOT NULL DEFAULT 0,
    "revision" BIGINT NOT NULL DEFAULT 0,
    "trackingSince" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationEmbeddingAccounting_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE INDEX "SemanticChunkPlan_organizationId_state_idx" ON "SemanticChunkPlan"("organizationId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "SemanticChunkPlan_organizationId_generationId_indexedDocume_key" ON "SemanticChunkPlan"("organizationId", "generationId", "indexedDocumentId");

-- CreateIndex
CREATE INDEX "EmbeddingWorkAttempt_organizationId_generationId_indexedDoc_idx" ON "EmbeddingWorkAttempt"("organizationId", "generationId", "indexedDocumentId", "purpose");

-- CreateIndex
CREATE INDEX "EmbeddingWorkAttempt_organizationId_state_deadlineAt_idx" ON "EmbeddingWorkAttempt"("organizationId", "state", "deadlineAt");

-- CreateIndex
CREATE INDEX "EmbeddingWorkAttempt_taskId_leaseEpoch_idx" ON "EmbeddingWorkAttempt"("taskId", "leaseEpoch");

-- CreateIndex
CREATE UNIQUE INDEX "EmbeddingWorkAttempt_operation_attempt_key" ON "EmbeddingWorkAttempt"("organizationId", "indexedDocumentId", "purpose", "operationKey", "batchOrdinal", "attemptNumber");

-- AddForeignKey
ALTER TABLE "SemanticChunkPlan" ADD CONSTRAINT "SemanticChunkPlan_organizationId_generationId_indexedDocum_fkey" FOREIGN KEY ("organizationId", "generationId", "indexedDocumentId") REFERENCES "IndexedDocument"("organizationId", "generationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingWorkAttempt" ADD CONSTRAINT "EmbeddingWorkAttempt_organizationId_generationId_indexedDo_fkey" FOREIGN KEY ("organizationId", "generationId", "indexedDocumentId") REFERENCES "IndexedDocument"("organizationId", "generationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationEmbeddingAccounting" ADD CONSTRAINT "OrganizationEmbeddingAccounting_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express canonical JSON, monotone checkpoint/evidence rules, or
-- cleanup admission locks. External calls remain outside application transactions;
-- these constraints do not attest to transport attempts or provider billing.
ALTER TABLE "OrganizationQuota" ADD CONSTRAINT "OrganizationQuota_semantic_limits_check" CHECK (
    "semanticUnitsPerDocument" BETWEEN 1 AND 8192
    AND "semanticPlanBytesPerDocument" BETWEEN 1024 AND 1048576
    AND "semanticPlanBytesPerOrganization" BETWEEN "semanticPlanBytesPerDocument" AND 9007199254740991
    AND "embeddingPreparedBytesPerCandidate" BETWEEN 1024 AND 9007199254740991
    AND "embeddingBatchesPerCandidate" BETWEEN 1 AND 4096
    AND "embeddingOutstandingPreparedBytes" BETWEEN "embeddingPreparedBytesPerCandidate" AND 9007199254740991
    AND "embeddingOutstandingBatches" BETWEEN "embeddingBatchesPerCandidate" AND 1000000
);
ALTER TABLE "IndexTask" ADD CONSTRAINT "IndexTask_continuations_check" CHECK ("continuations" >= 0);

-- Only numeric range records are accepted, so removing JSON formatting spaces
-- measures compact payload bytes without touching canonical document text.
CREATE FUNCTION vectorix_semantic_ranges_valid(ranges jsonb, maximum integer, overlapping boolean)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; ordinal integer := 0; from_offset numeric; to_offset numeric;
    previous_start integer := -1; previous_end integer := 0;
BEGIN
    IF ranges IS NULL OR jsonb_typeof(ranges) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(ranges) > maximum THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(ranges) LOOP
        IF jsonb_typeof(item) <> 'object'
            OR NOT (item ?& ARRAY['ordinal', 'start', 'end'])
            OR item - ARRAY['ordinal', 'start', 'end'] <> '{}'::jsonb
            OR jsonb_typeof(item->'ordinal') <> 'number'
            OR jsonb_typeof(item->'start') <> 'number'
            OR jsonb_typeof(item->'end') <> 'number' THEN RETURN false; END IF;
        from_offset := (item->>'start')::numeric;
        to_offset := (item->>'end')::numeric;
        IF (item->>'ordinal')::numeric <> ordinal
            OR trunc(from_offset) <> from_offset OR trunc(to_offset) <> to_offset
            OR from_offset < 0 OR from_offset >= to_offset OR to_offset > 26214400
            OR (NOT overlapping AND from_offset < previous_end)
            OR (overlapping AND (from_offset < previous_start OR to_offset <= previous_end))
            THEN RETURN false; END IF;
        previous_start := from_offset::integer;
        previous_end := to_offset::integer;
        ordinal := ordinal + 1;
    END LOOP;
    RETURN true;
END;
$$;
CREATE FUNCTION vectorix_semantic_scores_valid(scores jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; score numeric;
BEGIN
    IF scores IS NULL OR jsonb_typeof(scores) <> 'array' THEN RETURN false; END IF;
    IF jsonb_array_length(scores) > 8191 THEN RETURN false; END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(scores) LOOP
        IF jsonb_typeof(item) <> 'number' THEN RETURN false; END IF;
        score := item::text::numeric;
        IF score < 0 OR score > 2000000 OR trunc(score) <> score THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;
CREATE FUNCTION vectorix_semantic_plan_payload_valid(p "SemanticChunkPlan") RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE payload_bytes bigint;
BEGIN
    IF p.state = 'CLEANED' THEN
        RETURN p."unitRanges" = '[]'::jsonb AND p."boundaryScores" = '[]'::jsonb
            AND p."lastUnitVector" IS NULL AND p."finalRanges" IS NULL
            AND p."completedUnits" = 0 AND p."thresholdDistance" IS NULL
            AND p."storedBytes" = 0 AND p."reservedBytes" = 0
            AND p."reservedPreparedBytes" = 0 AND p."reservedBatches" = 0
            AND p."cleanedAt" IS NOT NULL;
    END IF;
    IF octet_length(p."unitRanges"::text) > 2097152
        OR octet_length(p."boundaryScores"::text) > 2097152
        OR octet_length(coalesce(p."finalRanges"::text, 'null')) > 2097152
        THEN RETURN false; END IF;
    IF NOT vectorix_semantic_ranges_valid(p."unitRanges", 8192, false)
        OR NOT vectorix_semantic_scores_valid(p."boundaryScores") THEN RETURN false; END IF;
    IF jsonb_array_length(p."unitRanges") <> p."unitCount"
        OR jsonb_array_length(p."boundaryScores") <> greatest(0, p."completedUnits" - 1)
        OR p."cleanedAt" IS NOT NULL THEN RETURN false; END IF;
    payload_bytes := octet_length(replace(p."unitRanges"::text, ' ', ''))
        + octet_length(replace(p."boundaryScores"::text, ' ', ''))
        + octet_length(replace(coalesce(p."finalRanges"::text, 'null'), ' ', ''))
        + coalesce(octet_length(p."lastUnitVector"), 0);
    IF payload_bytes > 1048576 OR p."storedBytes" < payload_bytes THEN RETURN false; END IF;
    IF p.state = 'PLANNING' THEN
        RETURN p."finalRanges" IS NULL AND p."planHash" IS NULL AND p."sealedAt" IS NULL
            AND p."thresholdDistance" IS NULL
            AND ((p."completedUnits" = 0 AND p."lastUnitVector" IS NULL)
                OR (p."completedUnits" > 0 AND p."lastUnitVector" IS NOT NULL));
    END IF;
    IF NOT vectorix_semantic_ranges_valid(p."finalRanges", 100000, true) THEN RETURN false; END IF;
    RETURN p.state = 'READY' AND p."completedUnits" = p."unitCount"
        AND p."lastUnitVector" IS NULL AND p."reservedBytes" = 0
        AND p."planHash" IS NOT NULL AND p."sealedAt" IS NOT NULL
        AND ((p."unitCount" = 0 AND jsonb_array_length(p."finalRanges") = 0)
            OR (p."unitCount" > 0 AND jsonb_array_length(p."finalRanges") > 0))
        AND ((p."unitCount" <= 1 AND p."thresholdDistance" IS NULL)
            OR (p."unitCount" > 1 AND p."thresholdDistance" IS NOT NULL));
END;
$$;
ALTER TABLE "SemanticChunkPlan" ADD CONSTRAINT "SemanticChunkPlan_bounds_check" CHECK (
    "configurationRevision" > 0 AND length("chunkerVersion") BETWEEN 1 AND 100
    AND length("unitizerVersion") BETWEEN 1 AND 100
    AND "sourceHash" ~ '^[a-f0-9]{64}$' AND "profileHash" ~ '^[a-f0-9]{64}$'
    AND "modelIdentity" ~ '^[a-f0-9]{64}$' AND "unitManifestHash" ~ '^[a-f0-9]{64}$'
    AND ("planHash" IS NULL OR "planHash" ~ '^[a-f0-9]{64}$')
    AND "unitCount" BETWEEN 0 AND 8192 AND "completedUnits" BETWEEN 0 AND "unitCount"
    AND ("thresholdDistance" IS NULL OR "thresholdDistance" BETWEEN 0 AND 2000000)
    AND ("lastUnitVector" IS NULL OR (octet_length("lastUnitVector") BETWEEN 4 AND 64000 AND octet_length("lastUnitVector") % 4 = 0))
    AND "reservedBytes" BETWEEN 0 AND 1048576 AND "storedBytes" BETWEEN 0 AND 1048576
    AND "reservedBytes" + "storedBytes" <= 1048576
    AND "reservedPreparedBytes" BETWEEN 0 AND 9007199254740991
    AND "reservedBatches" BETWEEN 0 AND 4096 AND revision >= 0
    AND vectorix_semantic_plan_payload_valid("SemanticChunkPlan")
);

CREATE FUNCTION vectorix_semantic_plan_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE dimensions integer;
BEGIN
    SELECT config.dimensions INTO dimensions FROM "IndexGeneration" generation
        JOIN "CollectionConfigRevision" config
          ON config."organizationId" = generation."organizationId"
         AND config."collectionId" = generation."collectionId"
         AND config.revision = generation."configurationRevision"
        WHERE generation.id = NEW."generationId" AND generation."organizationId" = NEW."organizationId"
          AND generation."configurationRevision" = NEW."configurationRevision"
          AND generation."modelIdentity" = NEW."modelIdentity"
          AND generation."chunkerVersion" = NEW."chunkerVersion";
    IF NOT FOUND OR (NEW."lastUnitVector" IS NOT NULL AND octet_length(NEW."lastUnitVector") <> dimensions * 4) THEN
        RAISE EXCEPTION 'Invalid semantic generation binding' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_generation_binding';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (NEW."indexedDocumentId", NEW."organizationId", NEW."generationId", NEW."configurationRevision",
            NEW."chunkerVersion", NEW."unitizerVersion", NEW."sourceHash", NEW."profileHash", NEW."modelIdentity",
            NEW."unitManifestHash", NEW."unitCount", NEW."createdAt") IS DISTINCT FROM
           (OLD."indexedDocumentId", OLD."organizationId", OLD."generationId", OLD."configurationRevision",
            OLD."chunkerVersion", OLD."unitizerVersion", OLD."sourceHash", OLD."profileHash", OLD."modelIdentity",
            OLD."unitManifestHash", OLD."unitCount", OLD."createdAt") OR NEW.revision < OLD.revision THEN
            RAISE EXCEPTION 'Semantic plan identity is immutable' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
        END IF;
        IF OLD.state = 'CLEANED' AND to_jsonb(NEW) - ARRAY['updatedAt', 'revision'] IS DISTINCT FROM to_jsonb(OLD) - ARRAY['updatedAt', 'revision'] THEN
            RAISE EXCEPTION 'Cleaned semantic plans cannot be revived' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
        END IF;
        IF NEW.state = 'CLEANED' AND (NEW."planHash", NEW."sealedAt") IS DISTINCT FROM (OLD."planHash", OLD."sealedAt") THEN
            RAISE EXCEPTION 'Semantic seal history is immutable' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
        END IF;
        IF NEW.state <> 'CLEANED' THEN
            IF NEW."unitRanges" IS DISTINCT FROM OLD."unitRanges"
                OR NEW."completedUnits" < OLD."completedUnits" THEN
                RAISE EXCEPTION 'Accepted semantic prefix is immutable' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
            END IF;
            -- Preserve score order and duplicates, not merely JSON array containment.
            IF EXISTS (SELECT 1 FROM jsonb_array_elements(OLD."boundaryScores") WITH ORDINALITY scores(value, ordinal)
                WHERE NEW."boundaryScores"->(ordinal::integer - 1) IS DISTINCT FROM value) THEN
                RAISE EXCEPTION 'Accepted semantic scores are immutable' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
            END IF;
            IF OLD.state = 'READY' AND (NEW.state, NEW."completedUnits", NEW."boundaryScores", NEW."lastUnitVector",
                    NEW."thresholdDistance", NEW."finalRanges", NEW."planHash", NEW."sealedAt", NEW."storedBytes") IS DISTINCT FROM
                   (OLD.state, OLD."completedUnits", OLD."boundaryScores", OLD."lastUnitVector",
                    OLD."thresholdDistance", OLD."finalRanges", OLD."planHash", OLD."sealedAt", OLD."storedBytes") THEN
                RAISE EXCEPTION 'Sealed semantic plans are immutable' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
            END IF;
            IF NEW.state = 'PLANNING' AND NEW."completedUnits" = OLD."completedUnits"
                AND NEW."lastUnitVector" IS DISTINCT FROM OLD."lastUnitVector" THEN
                RAISE EXCEPTION 'Accepted semantic checkpoint is immutable' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_immutable';
            END IF;
        END IF;
    END IF;
    IF NEW.state = 'CLEANED' AND EXISTS (SELECT 1 FROM "EmbeddingWorkAttempt" work
        WHERE work."indexedDocumentId" = NEW."indexedDocumentId"
          AND (work.state IN ('RESERVED', 'IN_FLIGHT') OR work."reservedPreparedBytes" <> 0 OR work."reservedBatches" <> 0)) THEN
        RAISE EXCEPTION 'Semantic work must settle before cleanup' USING ERRCODE = '23514', CONSTRAINT = 'SemanticChunkPlan_work_pending';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_semantic_plan_update BEFORE INSERT OR UPDATE ON "SemanticChunkPlan"
FOR EACH ROW EXECUTE FUNCTION vectorix_semantic_plan_update();

ALTER TABLE "EmbeddingWorkAttempt" ADD CONSTRAINT "EmbeddingWorkAttempt_bounds_check" CHECK (
    length("operationKey") BETWEEN 1 AND 128 AND "batchOrdinal" BETWEEN 0 AND 4095
    AND "attemptNumber" BETWEEN 1 AND 4096 AND "inputHash" ~ '^[a-f0-9]{64}$'
    AND "inputCount" BETWEEN 1 AND 2048 AND "preparedInputBytes" BETWEEN 1 AND 2097152
    AND length("taskId") BETWEEN 1 AND 200 AND "leaseEpoch" >= 0 AND "deadlineAt" >= "createdAt"
    AND "reservedBatches" BETWEEN 0 AND 1 AND "dispatchedBatches" BETWEEN 0 AND 1
    AND "reservedPreparedBytes" = "reservedBatches"::bigint * "preparedInputBytes"
    AND "dispatchedPreparedBytes" = "dispatchedBatches"::bigint * "preparedInputBytes"
    AND (("dispatchStartedAt" IS NULL) = ("dispatchedBatches" = 0))
    AND ("dispatchStartedAt" IS NULL OR "dispatchStartedAt" <= "deadlineAt")
    AND ("successfulRequests" IS NULL OR "successfulRequests" = 1)
    AND ("estimatedInputTokens" IS NULL OR "estimatedInputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("providerInputTokens" IS NULL OR "providerInputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("billedInputTokens" IS NULL OR "billedInputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("outcomeCode" IS NULL OR "outcomeCode" ~ '^[A-Z][A-Z0-9_]{0,63}$')
    AND (
        (state = 'RESERVED' AND "reservedBatches" = 1 AND "dispatchedBatches" = 0 AND "settledAt" IS NULL)
        OR (state = 'IN_FLIGHT' AND "reservedBatches" = 1 AND "dispatchedBatches" = 1 AND "settledAt" IS NULL)
        OR (state = 'CANCELLED' AND "reservedBatches" = 0 AND "dispatchedBatches" = 0 AND "settledAt" IS NOT NULL)
        OR (state IN ('FAILED', 'UNCERTAIN', 'SUCCEEDED') AND "reservedBatches" = 0 AND "dispatchedBatches" = 1 AND "settledAt" IS NOT NULL)
    )
    AND (
        (state = 'SUCCEEDED' AND "successfulRequests" IS NOT DISTINCT FROM 1 AND "estimatedInputTokens" IS NOT NULL AND "usageRecordedAt" IS NOT NULL)
        OR (state <> 'SUCCEEDED' AND "successfulRequests" IS NULL AND "estimatedInputTokens" IS NULL
            AND "providerInputTokens" IS NULL AND "billedInputTokens" IS NULL AND "usageRecordedAt" IS NULL)
    )
    AND ((state = 'UNCERTAIN' AND "uncertainAt" IS NOT NULL)
        OR state = 'SUCCEEDED' OR (state NOT IN ('UNCERTAIN', 'SUCCEEDED') AND "uncertainAt" IS NULL))
);
CREATE FUNCTION vectorix_embedding_work_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW."organizationId", NEW."generationId", NEW."indexedDocumentId", NEW.purpose,
        NEW."operationKey", NEW."batchOrdinal", NEW."attemptNumber", NEW."inputHash", NEW."inputCount",
        NEW."preparedInputBytes", NEW."taskId", NEW."leaseEpoch", NEW."createdAt", NEW."deadlineAt") IS DISTINCT FROM
       (OLD.id, OLD."organizationId", OLD."generationId", OLD."indexedDocumentId", OLD.purpose,
        OLD."operationKey", OLD."batchOrdinal", OLD."attemptNumber", OLD."inputHash", OLD."inputCount",
        OLD."preparedInputBytes", OLD."taskId", OLD."leaseEpoch", OLD."createdAt", OLD."deadlineAt")
        OR NEW."dispatchedBatches" < OLD."dispatchedBatches"
        OR (OLD."dispatchStartedAt" IS NOT NULL AND NEW."dispatchStartedAt" IS DISTINCT FROM OLD."dispatchStartedAt")
        OR (OLD."uncertainAt" IS NOT NULL AND NEW."uncertainAt" IS DISTINCT FROM OLD."uncertainAt") THEN
        RAISE EXCEPTION 'Embedding attempt evidence is immutable' USING ERRCODE = '23514', CONSTRAINT = 'EmbeddingWorkAttempt_immutable';
    END IF;
    IF NEW.state = OLD.state OR OLD.state IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
        IF to_jsonb(NEW) - 'updatedAt' IS DISTINCT FROM to_jsonb(OLD) - 'updatedAt' THEN
            RAISE EXCEPTION 'Settled embedding evidence is immutable' USING ERRCODE = '23514', CONSTRAINT = 'EmbeddingWorkAttempt_immutable';
        END IF;
    ELSIF NOT ((OLD.state = 'RESERVED' AND NEW.state IN ('IN_FLIGHT', 'CANCELLED'))
        OR (OLD.state = 'IN_FLIGHT' AND NEW.state IN ('SUCCEEDED', 'FAILED', 'UNCERTAIN'))
        OR (OLD.state = 'UNCERTAIN' AND NEW.state = 'SUCCEEDED')) THEN
        RAISE EXCEPTION 'Invalid embedding attempt transition' USING ERRCODE = '23514', CONSTRAINT = 'EmbeddingWorkAttempt_transition';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_embedding_work_update BEFORE UPDATE ON "EmbeddingWorkAttempt"
FOR EACH ROW EXECUTE FUNCTION vectorix_embedding_work_update();

ALTER TABLE "OrganizationEmbeddingAccounting" ADD CONSTRAINT "OrganizationEmbeddingAccounting_bounds_check" CHECK (
    "reservedPlanBytes" >= 0 AND "storedPlanBytes" >= 0 AND "reservedPreparedBytes" >= 0 AND "reservedBatches" >= 0
    AND "dispatchedPreparedBytes" >= 0 AND "dispatchedBatches" >= 0 AND "observedSuccessfulRequests" >= 0
    AND "observedEstimatedInputTokens" >= 0 AND "observedProviderInputTokens" >= 0
    AND "observedBilledInputTokens" >= 0 AND "observedBilledInputTokens" < 'Infinity'::double precision
    AND "unknownProviderTokenBatches" >= 0 AND "unknownBilledTokenBatches" >= 0 AND "uncertainAttempts" >= 0 AND revision >= 0
);

-- Preserve history while a candidate/organization survives. Parent FK cascades
-- run after parent removal and may delete settled metadata; ordinary cleanup clears
-- payload/capacity instead of deleting rows and resetting lifetime work budgets.
CREATE FUNCTION vectorix_semantic_history_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'OrganizationEmbeddingAccounting' THEN
        IF EXISTS (SELECT 1 FROM organization WHERE id = OLD."organizationId") THEN
            RAISE EXCEPTION 'Semantic history requires parent cleanup' USING ERRCODE = '23514', CONSTRAINT = 'semantic_history_parent_required';
        END IF;
    ELSIF EXISTS (SELECT 1 FROM "IndexedDocument" WHERE id = OLD."indexedDocumentId") THEN
        RAISE EXCEPTION 'Semantic history requires parent cleanup' USING ERRCODE = '23514', CONSTRAINT = 'semantic_history_parent_required';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER vectorix_semantic_plan_history BEFORE DELETE ON "SemanticChunkPlan"
FOR EACH ROW EXECUTE FUNCTION vectorix_semantic_history_delete();
CREATE TRIGGER vectorix_embedding_work_history BEFORE DELETE ON "EmbeddingWorkAttempt"
FOR EACH ROW EXECUTE FUNCTION vectorix_semantic_history_delete();
CREATE TRIGGER vectorix_embedding_accounting_history BEFORE DELETE ON "OrganizationEmbeddingAccounting"
FOR EACH ROW EXECUTE FUNCTION vectorix_semantic_history_delete();
CREATE TRIGGER vectorix_rag_semantic_plan_org BEFORE INSERT OR UPDATE ON "SemanticChunkPlan"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_embedding_work_org BEFORE INSERT OR UPDATE ON "EmbeddingWorkAttempt"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();
CREATE TRIGGER vectorix_rag_embedding_accounting_org BEFORE INSERT OR UPDATE ON "OrganizationEmbeddingAccounting"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();

-- Reuse the existing native-delete backstop and its public error mapping. Inspect
-- both actual rows and cached counters, so stale/absent accounting cannot erase
-- cleanup instructions. Settled historical usage alone does not block deletion.
CREATE OR REPLACE FUNCTION vectorix_rag_organization_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "DocumentVersion" WHERE "organizationId" = OLD.id AND ("discardedAt" IS NULL OR "contentState" <> 'PURGED'))
        OR EXISTS (SELECT 1 FROM "DocumentIngestion" WHERE "organizationId" = OLD.id AND "reservedBytes" > 0)
        OR EXISTS (SELECT 1 FROM "DocumentCleanup" WHERE "organizationId" = OLD.id AND status <> 'COMPLETE')
        OR EXISTS (SELECT 1 FROM "IndexGeneration" WHERE "organizationId" = OLD.id AND status <> 'CLEANED')
        OR EXISTS (SELECT 1 FROM "SemanticChunkPlan" WHERE "organizationId" = OLD.id
            AND (state <> 'CLEANED' OR "reservedBytes" <> 0 OR "storedBytes" <> 0
                OR "reservedPreparedBytes" <> 0 OR "reservedBatches" <> 0 OR "lastUnitVector" IS NOT NULL
                OR "unitRanges" <> '[]'::jsonb OR "boundaryScores" <> '[]'::jsonb OR "finalRanges" IS NOT NULL))
        OR EXISTS (SELECT 1 FROM "EmbeddingWorkAttempt" WHERE "organizationId" = OLD.id
            AND (state IN ('RESERVED', 'IN_FLIGHT') OR "reservedPreparedBytes" <> 0 OR "reservedBatches" <> 0))
        OR EXISTS (SELECT 1 FROM "OrganizationEmbeddingAccounting" WHERE "organizationId" = OLD.id
            AND ("reservedPlanBytes" <> 0 OR "storedPlanBytes" <> 0 OR "reservedPreparedBytes" <> 0 OR "reservedBatches" <> 0)) THEN
        RAISE EXCEPTION 'Delete RAG collections and documents, then wait for cleanup before deleting the organization'
            USING ERRCODE = '23514', CONSTRAINT = 'organization_rag_cleanup_required';
    END IF;
    RETURN OLD;
END;
$$;
