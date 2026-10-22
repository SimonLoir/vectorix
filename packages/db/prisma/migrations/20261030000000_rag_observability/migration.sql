-- CreateEnum
CREATE TYPE "RagOperationalWorkload" AS ENUM ('EXTRACTION', 'INDEX_STRUCTURE', 'INDEX_TOKEN', 'INDEX_SEMANTIC', 'SEARCH_LEXICAL', 'SEARCH_VECTOR', 'SEARCH_HYBRID');

-- CreateEnum
CREATE TYPE "RagTelemetryProvider" AS ENUM ('NONE', 'OLLAMA', 'COHERE', 'VOYAGE', 'OPENAI', 'MISTRAL');

-- CreateEnum
CREATE TYPE "RagWorkerLane" AS ENUM ('NOTIFICATIONS', 'DOCUMENTS', 'INDEXING');

-- CreateEnum
CREATE TYPE "RagWorkerScanOutcome" AS ENUM ('RETURNED', 'THREW');

-- CreateEnum
CREATE TYPE "RagWorkerFailure" AS ENUM ('SCAN_FAILED', 'DATABASE_UNAVAILABLE', 'REDIS_UNAVAILABLE', 'UNKNOWN');

-- CreateTable
CREATE TABLE "OrganizationRagTelemetry" (
    "organizationId" TEXT NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "trackingSince" TIMESTAMPTZ(3) NOT NULL,
    "lastRecordedAt" TIMESTAMPTZ(3) NOT NULL,
    "knownGapReports" BIGINT NOT NULL DEFAULT 0,
    "lastKnownGapReportedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OrganizationRagTelemetry_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "RagOperationalHour" (
    "organizationId" TEXT NOT NULL,
    "bucketStart" TIMESTAMPTZ(3) NOT NULL,
    "workload" "RagOperationalWorkload" NOT NULL,
    "provider" "RagTelemetryProvider" NOT NULL,
    "formatVersion" INTEGER NOT NULL DEFAULT 1,
    "lastRecordedAt" TIMESTAMPTZ(3) NOT NULL,
    "recordedStarts" BIGINT NOT NULL DEFAULT 0,
    "recordedSuccesses" BIGINT NOT NULL DEFAULT 0,
    "recordedFailures" BIGINT NOT NULL DEFAULT 0,
    "recordedContinuations" BIGINT NOT NULL DEFAULT 0,
    "recordedSupersessions" BIGINT NOT NULL DEFAULT 0,
    "recordedDenials" BIGINT NOT NULL DEFAULT 0,
    "nativeStarts" BIGINT NOT NULL DEFAULT 0,
    "nativeValidatedBatches" BIGINT NOT NULL DEFAULT 0,
    "nativeFailedBatches" BIGINT NOT NULL DEFAULT 0,
    "validatedVectors" BIGINT NOT NULL DEFAULT 0,
    "dispatchedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "validatedPreparedBytes" BIGINT NOT NULL DEFAULT 0,
    "validatedEstimatedInputTokens" BIGINT NOT NULL DEFAULT 0,
    "knownProviderInputTokens" BIGINT NOT NULL DEFAULT 0,
    "unknownProviderTokenBatches" BIGINT NOT NULL DEFAULT 0,
    "unknownBilledTokenBatches" BIGINT NOT NULL DEFAULT 0,
    "knownBilledInputTokens" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sourceReadBytes" BIGINT,
    "artifactWrittenBytes" BIGINT,
    "phaseStats" JSONB NOT NULL DEFAULT '{}',
    "failureCounts" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "RagOperationalHour_pkey" PRIMARY KEY ("organizationId","bucketStart","workload","provider")
);

-- CreateTable
CREATE TABLE "RagWorkerLaneObservation" (
    "lane" "RagWorkerLane" NOT NULL,
    "lastHeartbeatObservedAt" TIMESTAMPTZ(3),
    "lastScanStartObservedAt" TIMESTAMPTZ(3),
    "lastScanFinishObservedAt" TIMESTAMPTZ(3),
    "lastFinishedScanStartObservedAt" TIMESTAMPTZ(3),
    "lastFinishedScanDurationMicros" BIGINT,
    "lastScanOutcome" "RagWorkerScanOutcome",
    "lastSafeFailure" "RagWorkerFailure",

    CONSTRAINT "RagWorkerLaneObservation_pkey" PRIMARY KEY ("lane")
);

-- CreateIndex
CREATE INDEX "RagOperationalHour_bucketStart_organizationId_idx" ON "RagOperationalHour"("bucketStart", "organizationId");

-- AddForeignKey
ALTER TABLE "OrganizationRagTelemetry" ADD CONSTRAINT "OrganizationRagTelemetry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RagOperationalHour" ADD CONSTRAINT "RagOperationalHour_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Prisma cannot express the fixed observational JSON format, feasible bounded
-- histograms, or immutable observation identities. These helpers inspect only
-- their arguments; no telemetry row is created/backfilled by this migration.
CREATE FUNCTION vectorix_telemetry_decimal(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE digits text;
BEGIN
    IF value IS NULL OR jsonb_typeof(value) <> 'string' THEN RETURN false; END IF;
    digits := value #>> '{}';
    IF digits !~ '^(0|[1-9][0-9]*)$' OR length(digits) > 19 THEN RETURN false; END IF;
    RETURN digits::numeric <= 9223372036854775807::numeric;
END;
$$;

CREATE FUNCTION vectorix_telemetry_phases(value jsonb, workload "RagOperationalWorkload") RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
    allowed text[];
    phase record;
    histogram jsonb;
    samples numeric;
    total numeric;
    maximum numeric;
    count_value numeric;
    count_sum numeric;
    lower_sum numeric;
    upper_sum numeric;
    lower_bound numeric;
    highest_lower numeric;
    highest_upper numeric;
    upper_bounds numeric[] := ARRAY[1000,5000,10000,25000,50000,100000,250000,500000,1000000,2500000,5000000,10000000,30000000,90000000,300000000,NULL]::numeric[];
    slot integer;
BEGIN
    IF value IS NULL OR jsonb_typeof(value) <> 'object' OR octet_length(value::text) > 8192 THEN RETURN false; END IF;
    allowed := CASE
        WHEN workload = 'EXTRACTION' THEN ARRAY['SOURCE_READ','PARSE_EXTRACT','ARTIFACT_WRITE','CATALOG_PUBLISH','EXECUTION_TOTAL']
        WHEN workload = 'INDEX_SEMANTIC' THEN ARRAY['SOURCE_READ','PLAN','MATERIALIZE_SEAL','FINAL_EMBED','VECTOR_WRITE_SEAL','CATALOG_PUBLISH','EXECUTION_TOTAL','BOUNDARY_EMBED']
        WHEN workload IN ('INDEX_STRUCTURE','INDEX_TOKEN') THEN ARRAY['SOURCE_READ','PLAN','MATERIALIZE_SEAL','FINAL_EMBED','VECTOR_WRITE_SEAL','CATALOG_PUBLISH','EXECUTION_TOTAL']
        ELSE ARRAY['PREFLIGHT','QUERY_EMBED','LEXICAL','VECTOR','FUSION_HYDRATE','SERVICE_TOTAL','INTERNAL_PHASE_UNION']
    END;
    FOR phase IN SELECT key, val FROM jsonb_each(value) AS entry(key,val) LOOP
        IF NOT phase.key = ANY(allowed) OR jsonb_typeof(phase.val) <> 'object' THEN RETURN false; END IF;
        IF (SELECT count(*) FROM jsonb_object_keys(phase.val)) <> 4
            OR NOT phase.val ?& ARRAY['samples','sumMicros','maxMicros','buckets']
            OR NOT vectorix_telemetry_decimal(phase.val->'samples')
            OR NOT vectorix_telemetry_decimal(phase.val->'sumMicros')
            OR NOT vectorix_telemetry_decimal(phase.val->'maxMicros')
        THEN RETURN false; END IF;
        histogram := phase.val->'buckets';
        IF jsonb_typeof(histogram) IS DISTINCT FROM 'array' THEN RETURN false; END IF;
        IF jsonb_array_length(histogram) <> 16 THEN RETURN false; END IF;
        samples := (phase.val->>'samples')::numeric;
        total := (phase.val->>'sumMicros')::numeric;
        maximum := (phase.val->>'maxMicros')::numeric;
        count_sum := 0; lower_sum := 0; upper_sum := 0;
        highest_lower := NULL; highest_upper := NULL;
        FOR slot IN 1..16 LOOP
            IF NOT vectorix_telemetry_decimal(histogram->(slot-1)) THEN RETURN false; END IF;
            count_value := (histogram->>(slot-1))::numeric;
            lower_bound := CASE WHEN slot=1 THEN 0 ELSE upper_bounds[slot-1]+1 END;
            count_sum := count_sum+count_value;
            lower_sum := lower_sum+count_value*lower_bound;
            upper_sum := upper_sum+count_value*LEAST(COALESCE(upper_bounds[slot],maximum),maximum);
            IF count_value > 0 THEN
                highest_lower := lower_bound;
                highest_upper := upper_bounds[slot];
            END IF;
        END LOOP;
        IF count_sum <> samples THEN RETURN false; END IF;
        IF samples=0 THEN
            IF total<>0 OR maximum<>0 THEN RETURN false; END IF;
        ELSE
            IF highest_lower IS NULL OR maximum < highest_lower
                OR (highest_upper IS NOT NULL AND maximum > highest_upper)
                OR total < lower_sum+maximum-highest_lower OR total > upper_sum
            THEN RETURN false; END IF;
        END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE FUNCTION vectorix_telemetry_failures(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE item record;
BEGIN
    IF value IS NULL OR jsonb_typeof(value) <> 'object' OR octet_length(value::text) > 1024 THEN RETURN false; END IF;
    FOR item IN SELECT key,val FROM jsonb_each(value) AS entry(key,val) LOOP
        IF NOT item.key = ANY(ARRAY['ACCESS','PROFILE','CREDENTIALS','PROVIDER','STORAGE','SOURCE','VECTOR','QUOTA','LEASE','INPUT','PROCESSING','OTHER'])
            OR NOT vectorix_telemetry_decimal(item.val)
        THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;

-- Atomic merges keep concurrent writers from replacing another reporter's
-- buckets. NUMERIC intermediates cannot overflow before range validation.
CREATE FUNCTION vectorix_telemetry_merge_phases(previous jsonb, delta jsonb, workload "RagOperationalWorkload") RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result jsonb := previous; item record; prior jsonb; merged jsonb; bins jsonb;
BEGIN
    IF NOT vectorix_telemetry_phases(previous,workload) OR NOT vectorix_telemetry_phases(delta,workload) THEN
        RAISE EXCEPTION 'Invalid telemetry phase input' USING ERRCODE='23514',CONSTRAINT='RagOperationalHour_phases';
    END IF;
    FOR item IN SELECT key,val FROM jsonb_each(delta) AS entry(key,val) LOOP
        prior := result->item.key;
        IF prior IS NULL THEN result := result || jsonb_build_object(item.key,item.val); CONTINUE; END IF;
        SELECT jsonb_agg(to_jsonb(((prior->'buckets'->>slot)::numeric+(item.val->'buckets'->>slot)::numeric)::text) ORDER BY slot)
            INTO bins FROM generate_series(0,15) slot;
        merged := jsonb_build_object(
            'samples',((prior->>'samples')::numeric+(item.val->>'samples')::numeric)::text,
            'sumMicros',((prior->>'sumMicros')::numeric+(item.val->>'sumMicros')::numeric)::text,
            'maxMicros',GREATEST((prior->>'maxMicros')::numeric,(item.val->>'maxMicros')::numeric)::text,
            'buckets',bins);
        result := result || jsonb_build_object(item.key,merged);
    END LOOP;
    IF NOT vectorix_telemetry_phases(result,workload) THEN
        RAISE EXCEPTION 'Invalid telemetry phase merge' USING ERRCODE='23514',CONSTRAINT='RagOperationalHour_phases';
    END IF;
    RETURN result;
END;
$$;

CREATE FUNCTION vectorix_telemetry_merge_failures(previous jsonb, delta jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE result jsonb := previous; item record;
BEGIN
    IF NOT vectorix_telemetry_failures(previous) OR NOT vectorix_telemetry_failures(delta) THEN
        RAISE EXCEPTION 'Invalid telemetry failure input' USING ERRCODE='23514',CONSTRAINT='RagOperationalHour_failures';
    END IF;
    FOR item IN SELECT key,val FROM jsonb_each(delta) AS entry(key,val) LOOP
        result := result || jsonb_build_object(item.key,(COALESCE((result->>item.key)::numeric,0)+(item.val #>> '{}')::numeric)::text);
    END LOOP;
    IF NOT vectorix_telemetry_failures(result) THEN
        RAISE EXCEPTION 'Invalid telemetry failure merge' USING ERRCODE='23514',CONSTRAINT='RagOperationalHour_failures';
    END IF;
    RETURN result;
END;
$$;

ALTER TABLE "OrganizationRagTelemetry"
    ADD CONSTRAINT "OrganizationRagTelemetry_shape" CHECK (
        "formatVersion"=1 AND "knownGapReports">=0
        AND isfinite("trackingSince") AND isfinite("lastRecordedAt")
        AND "trackingSince" <= "lastRecordedAt"
        AND ("lastKnownGapReportedAt" IS NULL OR (
            isfinite("lastKnownGapReportedAt") AND "lastKnownGapReportedAt">="trackingSince"
            AND "lastKnownGapReportedAt"<="lastRecordedAt"
        ))
    );

ALTER TABLE "RagOperationalHour"
    ADD CONSTRAINT "RagOperationalHour_identity" CHECK (
        "formatVersion"=1 AND isfinite("bucketStart") AND isfinite("lastRecordedAt")
        AND "bucketStart" = (date_trunc('hour',"bucketStart" AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND "lastRecordedAt">="bucketStart"
        AND ((workload IN ('EXTRACTION','SEARCH_LEXICAL') AND provider='NONE')
            OR (workload NOT IN ('EXTRACTION','SEARCH_LEXICAL') AND provider<>'NONE'))
    ),
    ADD CONSTRAINT "RagOperationalHour_counters" CHECK (
        "recordedStarts">=0 AND "recordedSuccesses">=0 AND "recordedFailures">=0
        AND "recordedContinuations">=0 AND "recordedSupersessions">=0 AND "recordedDenials">=0
        AND "nativeStarts">=0 AND "nativeValidatedBatches">=0 AND "nativeFailedBatches">=0
        AND "validatedVectors">=0 AND "dispatchedPreparedBytes">=0 AND "validatedPreparedBytes">=0
        AND "validatedEstimatedInputTokens">=0 AND "knownProviderInputTokens">=0
        AND "unknownProviderTokenBatches">=0 AND "unknownBilledTokenBatches">=0
        AND "knownBilledInputTokens">=0 AND "knownBilledInputTokens"<'Infinity'::float8
        AND ("sourceReadBytes" IS NULL OR "sourceReadBytes">=0)
        AND ("artifactWrittenBytes" IS NULL OR "artifactWrittenBytes">=0)
    ),
    ADD CONSTRAINT "RagOperationalHour_phases" CHECK (vectorix_telemetry_phases("phaseStats",workload)),
    ADD CONSTRAINT "RagOperationalHour_failures" CHECK (vectorix_telemetry_failures("failureCounts")),
    -- A complete validated native event is captured atomically. Starts and
    -- completions may be in different hours and are deliberately not related.
    ADD CONSTRAINT "RagOperationalHour_native_success" CHECK (
        "unknownProviderTokenBatches" <= "nativeValidatedBatches"
        AND "unknownBilledTokenBatches" <= "nativeValidatedBatches"
        AND "validatedVectors">="nativeValidatedBatches"
        AND ("nativeValidatedBatches">0 OR ("validatedVectors"=0 AND "validatedPreparedBytes"=0
            AND "validatedEstimatedInputTokens"=0 AND "knownProviderInputTokens"=0 AND "knownBilledInputTokens"=0))
        AND ("unknownProviderTokenBatches"<>"nativeValidatedBatches" OR "knownProviderInputTokens"=0)
        AND ("unknownBilledTokenBatches"<>"nativeValidatedBatches" OR "knownBilledInputTokens"=0)
    );

ALTER TABLE "RagWorkerLaneObservation"
    ADD CONSTRAINT "RagWorkerLaneObservation_shape" CHECK (
        ("lastHeartbeatObservedAt" IS NULL OR isfinite("lastHeartbeatObservedAt"))
        AND ("lastScanStartObservedAt" IS NULL OR isfinite("lastScanStartObservedAt"))
        AND ("lastScanFinishObservedAt" IS NULL OR isfinite("lastScanFinishObservedAt"))
        AND ("lastFinishedScanDurationMicros" IS NULL OR "lastFinishedScanDurationMicros">=0)
        AND (("lastScanFinishObservedAt" IS NULL AND "lastScanOutcome" IS NULL
                AND "lastFinishedScanStartObservedAt" IS NULL AND "lastFinishedScanDurationMicros" IS NULL AND "lastSafeFailure" IS NULL)
            OR ("lastScanFinishObservedAt" IS NOT NULL AND "lastScanOutcome" IS NOT NULL
                AND ("lastFinishedScanStartObservedAt" IS NULL OR (
                    isfinite("lastFinishedScanStartObservedAt") AND "lastFinishedScanStartObservedAt"<="lastScanFinishObservedAt"))
                AND (("lastScanOutcome"='RETURNED' AND "lastSafeFailure" IS NULL)
                    OR ("lastScanOutcome"='THREW' AND "lastSafeFailure" IS NOT NULL))))
    );

CREATE FUNCTION vectorix_telemetry_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME='OrganizationRagTelemetry' THEN
        IF ROW(NEW."organizationId",NEW."formatVersion",NEW."trackingSince") IS DISTINCT FROM ROW(OLD."organizationId",OLD."formatVersion",OLD."trackingSince") THEN
            RAISE EXCEPTION 'Telemetry marker identity is immutable' USING ERRCODE='23514',CONSTRAINT='OrganizationRagTelemetry_immutable';
        END IF;
        IF NEW."lastRecordedAt"<OLD."lastRecordedAt" OR (OLD."lastKnownGapReportedAt" IS NOT NULL AND (NEW."lastKnownGapReportedAt" IS NULL OR NEW."lastKnownGapReportedAt"<OLD."lastKnownGapReportedAt")) THEN
            RAISE EXCEPTION 'Telemetry observations cannot move backwards' USING ERRCODE='23514',CONSTRAINT='OrganizationRagTelemetry_order';
        END IF;
    ELSIF TG_TABLE_NAME='RagOperationalHour' THEN
        IF ROW(NEW."organizationId",NEW."bucketStart",NEW.workload,NEW.provider,NEW."formatVersion") IS DISTINCT FROM ROW(OLD."organizationId",OLD."bucketStart",OLD.workload,OLD.provider,OLD."formatVersion") THEN
            RAISE EXCEPTION 'Telemetry hour identity is immutable' USING ERRCODE='23514',CONSTRAINT='RagOperationalHour_immutable';
        END IF;
        IF NEW."lastRecordedAt"<OLD."lastRecordedAt" THEN
            RAISE EXCEPTION 'Telemetry observations cannot move backwards' USING ERRCODE='23514',CONSTRAINT='RagOperationalHour_order';
        END IF;
    ELSE
        IF NEW.lane IS DISTINCT FROM OLD.lane THEN
            RAISE EXCEPTION 'Worker lane identity is immutable' USING ERRCODE='23514',CONSTRAINT='RagWorkerLaneObservation_immutable';
        END IF;
        IF (OLD."lastHeartbeatObservedAt" IS NOT NULL AND (NEW."lastHeartbeatObservedAt" IS NULL OR NEW."lastHeartbeatObservedAt"<OLD."lastHeartbeatObservedAt"))
            OR (OLD."lastScanStartObservedAt" IS NOT NULL AND (NEW."lastScanStartObservedAt" IS NULL OR NEW."lastScanStartObservedAt"<OLD."lastScanStartObservedAt"))
            OR (OLD."lastScanFinishObservedAt" IS NOT NULL AND (NEW."lastScanFinishObservedAt" IS NULL OR NEW."lastScanFinishObservedAt"<OLD."lastScanFinishObservedAt"))
        THEN RAISE EXCEPTION 'Worker observations cannot move backwards' USING ERRCODE='23514',CONSTRAINT='RagWorkerLaneObservation_order'; END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER "OrganizationRagTelemetry_identity" BEFORE UPDATE ON "OrganizationRagTelemetry" FOR EACH ROW EXECUTE FUNCTION vectorix_telemetry_identity();
CREATE TRIGGER "RagOperationalHour_identity" BEFORE UPDATE ON "RagOperationalHour" FOR EACH ROW EXECUTE FUNCTION vectorix_telemetry_identity();
CREATE TRIGGER "RagWorkerLaneObservation_identity" BEFORE UPDATE ON "RagWorkerLaneObservation" FOR EACH ROW EXECUTE FUNCTION vectorix_telemetry_identity();
