-- Synthetic observations are transaction-local and rolled back. These are
-- database format/integrity proofs, never actual activity/usage or load claims.
BEGIN;
DO $$ BEGIN
    IF current_database() NOT IN ('vectorix_catalog_test','vectorix_upgrade_test','vectorix_observability_schema_test') THEN
        RAISE EXCEPTION 'Telemetry SQL proofs require an owned disposable _test database';
    END IF;
END $$;
INSERT INTO organization (id,name,slug,"createdAt")
VALUES ('telemetry-schema-org','Telemetry SQL fixture','telemetry-schema-org',now());
INSERT INTO "OrganizationRagTelemetry" ("organizationId","trackingSince","lastRecordedAt")
VALUES ('telemetry-schema-org','2026-01-01T00:00Z','2026-01-01T01:00Z');
INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt")
VALUES ('telemetry-schema-org','2026-01-01T00:00Z','INDEX_SEMANTIC','OLLAMA','2026-01-01T00:01Z');
INSERT INTO "RagWorkerLaneObservation" (lane) VALUES ('INDEXING');
CREATE TEMP TABLE telemetry_schema_proofs (name text PRIMARY KEY);
CREATE FUNCTION pg_temp.telemetry_reject(statement text, expected_constraint text, proof text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_constraint text;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN integrity_constraint_violation THEN
        GET STACKED DIAGNOSTICS actual_constraint=CONSTRAINT_NAME;
        IF expected_constraint IS NOT NULL AND actual_constraint IS DISTINCT FROM expected_constraint THEN
            RAISE EXCEPTION 'Wrong telemetry constraint: expected %, got %',expected_constraint,actual_constraint;
        END IF;
        INSERT INTO telemetry_schema_proofs VALUES(proof);
        RETURN;
    END;
    RAISE EXCEPTION 'Invalid telemetry mutation was accepted: %',proof;
END;
$$;
CREATE FUNCTION pg_temp.telemetry_phase(samples text,total text,maximum text,slot integer,count_value text) RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('samples',samples,'sumMicros',total,'maxMicros',maximum,
        'buckets',(SELECT jsonb_agg(CASE WHEN n=slot THEN count_value ELSE '0' END ORDER BY n) FROM generate_series(0,15) n))
$$;

DO $$
DECLARE value jsonb; item text; field text; index integer; statement text; allowed integer;
BEGIN
    -- Exact fixed workload/provider pairs (7x6 finite possibilities).
    allowed:=0;
    FOR item IN SELECT workload::text||'/'||provider::text FROM unnest(enum_range(NULL::"RagOperationalWorkload")) workload CROSS JOIN unnest(enum_range(NULL::"RagTelemetryProvider")) provider LOOP
        statement:=format('INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt") VALUES (''telemetry-schema-org'',''2026-01-02T00:00Z'',%L,%L,''2026-01-02T00:01Z'')',split_part(item,'/',1),split_part(item,'/',2));
        IF (split_part(item,'/',1) IN ('EXTRACTION','SEARCH_LEXICAL')) = (split_part(item,'/',2)='NONE') THEN
            EXECUTE statement; allowed:=allowed+1;
        ELSE PERFORM pg_temp.telemetry_reject(statement,'RagOperationalHour_identity','invalid workload/provider '||item); END IF;
    END LOOP;
    IF allowed<>27 THEN RAISE EXCEPTION 'Wrong finite workload/provider cardinality'; END IF;
    INSERT INTO telemetry_schema_proofs VALUES('all 27 allowed workload/provider pairs');
    -- Subsequent PLAN mutations must target exactly the semantic owner, or a
    -- different workload's forbidden PLAN could mask a broken value validator.
    DELETE FROM "RagOperationalHour" WHERE "organizationId"='telemetry-schema-org' AND "bucketStart"='2026-01-02T00:00Z';

    FOREACH item IN ARRAY ARRAY['recordedStarts','recordedSuccesses','recordedFailures','recordedContinuations','recordedSupersessions','recordedDenials','nativeStarts','nativeValidatedBatches','nativeFailedBatches','validatedVectors','dispatchedPreparedBytes','validatedPreparedBytes','validatedEstimatedInputTokens','knownProviderInputTokens','unknownProviderTokenBatches','unknownBilledTokenBatches','knownBilledInputTokens','sourceReadBytes','artifactWrittenBytes'] LOOP
        PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET %I=-1 WHERE "organizationId"=''telemetry-schema-org'' AND "bucketStart"=''2026-01-01T00:00Z''',item),NULL,'negative '||item);
    END LOOP;
    FOREACH item IN ARRAY ARRAY['NaN','Infinity','-Infinity'] LOOP
        PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET "knownBilledInputTokens"=%L::float8 WHERE "organizationId"=''telemetry-schema-org''',item),'RagOperationalHour_counters','nonfinite billed '||item);
    END LOOP;
    FOR value IN SELECT val FROM (VALUES ('null'::jsonb),('[]'::jsonb),('"raw"'::jsonb),('1'::jsonb),('true'::jsonb)) invalid(val) LOOP
        PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET "phaseStats"=%L::jsonb WHERE "organizationId"=''telemetry-schema-org''',value),'RagOperationalHour_phases','phase root '||value::text);
        PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET "failureCounts"=%L::jsonb WHERE "organizationId"=''telemetry-schema-org''',value),'RagOperationalHour_failures','failure root '||value::text);
    END LOOP;
    FOR value IN SELECT val FROM (VALUES ('null'::jsonb),('0'::jsonb),('"01"'::jsonb),('"-1"'::jsonb),('"1.0"'::jsonb),('"1e2"'::jsonb),('"9223372036854775808"'::jsonb),('""'::jsonb)) invalid(val) LOOP
        PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET "failureCounts"=jsonb_build_object(''OTHER'',%L::jsonb) WHERE "organizationId"=''telemetry-schema-org''',value),'RagOperationalHour_failures','failure decimal '||value::text);
        FOREACH field IN ARRAY ARRAY['samples','sumMicros','maxMicros'] LOOP
            PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET "phaseStats"=jsonb_build_object(''PLAN'',jsonb_set(%L::jsonb,ARRAY[%L],%L::jsonb)) WHERE "organizationId"=''telemetry-schema-org''',pg_temp.telemetry_phase('1','0','0',0,'1'),field,value),'RagOperationalHour_phases','phase decimal '||field||' '||value::text);
        END LOOP;
    END LOOP;
    FOR value IN SELECT val FROM (VALUES
        ('null'::jsonb),('{}'::jsonb),
        (pg_temp.telemetry_phase('1','0','0',0,'1')||'{"extra":"0"}'),
        (pg_temp.telemetry_phase('1','0','0',0,'1')-'maxMicros'),
        (jsonb_set(pg_temp.telemetry_phase('1','0','0',0,'1'),'{buckets}','null')),
        (jsonb_set(pg_temp.telemetry_phase('1','0','0',0,'1'),'{buckets}','[]')),
        (jsonb_set(pg_temp.telemetry_phase('1','0','0',0,'1'),'{buckets,0}','null')),
        (pg_temp.telemetry_phase('2','0','0',0,'1')),
        (pg_temp.telemetry_phase('0','1','0',0,'0')),
        (pg_temp.telemetry_phase('0','0','1',0,'0')),
        (pg_temp.telemetry_phase('1','0','0',15,'1')),
        (pg_temp.telemetry_phase('1','1000','1000',1,'1')),
        (pg_temp.telemetry_phase('1','1001','1001',0,'1')),
        (pg_temp.telemetry_phase('2','1000','1000',1,'2')),
        (pg_temp.telemetry_phase('2','6000','5000',1,'2')),
        (pg_temp.telemetry_phase('2','10001','5000',1,'2')),
        (pg_temp.telemetry_phase('9223372036854775807','0','0',15,'9223372036854775807'))
    ) invalid(val) LOOP
        index:=COALESCE(index,0)+1;
        PERFORM pg_temp.telemetry_reject(format('UPDATE "RagOperationalHour" SET "phaseStats"=jsonb_build_object(''PLAN'',%L::jsonb) WHERE "organizationId"=''telemetry-schema-org''',value),'RagOperationalHour_phases','histogram shape/feasibility '||index);
    END LOOP;
END $$;

SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "phaseStats"='{"secret-model":{}}' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_phases','unknown phase label');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "phaseStats"=jsonb_build_object('QUERY_EMBED',pg_temp.telemetry_phase('1','0','0',0,'1')) WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_phases','otherwise valid search phase forbidden on semantic indexing');
INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt","phaseStats")
VALUES ('telemetry-schema-org','2026-01-04T00:00Z','SEARCH_HYBRID','OLLAMA','2026-01-04T00:01Z',jsonb_build_object('INTERNAL_PHASE_UNION',pg_temp.telemetry_phase('1','0','0',0,'1')));
INSERT INTO telemetry_schema_proofs VALUES('reviewed internal phase union accepted for search');
DELETE FROM "RagOperationalHour" WHERE "organizationId"='telemetry-schema-org' AND "bucketStart"='2026-01-04T00:00Z';
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "failureCounts"='{"raw error":"1"}' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_failures','unknown failure label');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "phaseStats"=jsonb_build_object('PLAN',jsonb_build_object('samples',repeat('1',8200))) WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_phases','bounded phase payload');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "failureCounts"=jsonb_build_object('OTHER',repeat('1',1024)) WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_failures','bounded failure payload');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "nativeValidatedBatches"=1 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_native_success','validated batch has at least one vector');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "unknownProviderTokenBatches"=1 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_native_success','unknown provider batch belongs to validated success');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "unknownBilledTokenBatches"=1 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_native_success','unknown billed batch belongs to validated success');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "validatedPreparedBytes"=1 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_native_success','validated bytes need a success');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "nativeValidatedBatches"=1,"validatedVectors"=1,"unknownProviderTokenBatches"=1,"knownProviderInputTokens"=1 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_native_success','all unknown provider usage has no known subtotal');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "nativeValidatedBatches"=1,"validatedVectors"=1,"unknownBilledTokenBatches"=1,"knownBilledInputTokens"=0.5 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_native_success','all unknown billed usage has no known subtotal');

-- Valid numerical edges: real 0 duration, inclusive bucket upper, open tail,
-- an attained maximum and huge NUMERIC intermediates (not BIGINT arithmetic).
DO $$ DECLARE value jsonb; merged jsonb; BEGIN
    FOREACH value IN ARRAY ARRAY[pg_temp.telemetry_phase('1','0','0',0,'1'),pg_temp.telemetry_phase('2','6001','5000',1,'2'),pg_temp.telemetry_phase('1','300000001','300000001',15,'1'),pg_temp.telemetry_phase('9223372036854775807','0','0',0,'9223372036854775807')] LOOP
        IF NOT vectorix_telemetry_phases(jsonb_build_object('PLAN',value),'INDEX_SEMANTIC') THEN RAISE EXCEPTION 'Valid histogram edge rejected'; END IF;
    END LOOP;
    INSERT INTO telemetry_schema_proofs VALUES('valid inclusive/zero/tail/max-int histogram edges');
    merged:=vectorix_telemetry_merge_phases(jsonb_build_object('PLAN',pg_temp.telemetry_phase('1','1001','1001',1,'1')),jsonb_build_object('PLAN',pg_temp.telemetry_phase('1','5000','5000',1,'1')),'INDEX_SEMANTIC');
    IF merged->'PLAN'<>pg_temp.telemetry_phase('2','6001','5000',1,'2') THEN RAISE EXCEPTION 'Phase merge lost maxima/buckets'; END IF;
    IF vectorix_telemetry_merge_failures('{"OTHER":"2"}','{"OTHER":"3","LEASE":"1"}')<>'{"OTHER":"5","LEASE":"1"}' THEN RAISE EXCEPTION 'Failure merge lost counts'; END IF;
    INSERT INTO telemetry_schema_proofs VALUES('exact fixed histogram and failure merges');
END $$;
SELECT pg_temp.telemetry_reject($q$SELECT vectorix_telemetry_merge_phases(jsonb_build_object('PLAN',pg_temp.telemetry_phase('9223372036854775807','0','0',0,'9223372036854775807')),jsonb_build_object('PLAN',pg_temp.telemetry_phase('1','0','0',0,'1')),'INDEX_SEMANTIC')$q$,'RagOperationalHour_phases','merged signed64 overflow rejects');
SELECT pg_temp.telemetry_reject($q$SELECT vectorix_telemetry_merge_failures('{"OTHER":"9223372036854775807"}','{"OTHER":"1"}')$q$,'RagOperationalHour_failures','merged failure signed64 overflow rejects');

-- No same-hour conservation: valid starts/outcomes in different recording
-- hours, known zero usage, unknown billed usage and unobserved byte NULLs.
UPDATE "RagOperationalHour" SET "recordedSuccesses"=5,"nativeValidatedBatches"=1,"validatedVectors"=2,"unknownBilledTokenBatches"=1
WHERE "organizationId"='telemetry-schema-org' AND "bucketStart"='2026-01-01T00:00Z';
DO $$ BEGIN
    IF EXISTS(SELECT FROM "RagOperationalHour" WHERE "organizationId"='telemetry-schema-org' AND ("sourceReadBytes" IS NOT NULL OR "artifactWrittenBytes" IS NOT NULL)) THEN RAISE EXCEPTION 'Unobserved bytes are not NULL'; END IF;
    INSERT INTO telemetry_schema_proofs VALUES('cross-hour outcomes known-zero usage and unknown bytes');
END $$;
UPDATE "RagOperationalHour" SET "sourceReadBytes"=0,"artifactWrittenBytes"=9223372036854775807 WHERE "organizationId"='telemetry-schema-org';
INSERT INTO telemetry_schema_proofs VALUES('actual zero and max-int I/O byte observations');

SELECT pg_temp.telemetry_reject($q$UPDATE "OrganizationRagTelemetry" SET "knownGapReports"=-1 WHERE "organizationId"='telemetry-schema-org'$q$,'OrganizationRagTelemetry_shape','negative marker gaps');
SELECT pg_temp.telemetry_reject($q$UPDATE "OrganizationRagTelemetry" SET "formatVersion"=2 WHERE "organizationId"='telemetry-schema-org'$q$,'OrganizationRagTelemetry_immutable','marker format immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "OrganizationRagTelemetry" SET "organizationId"='foreign-telemetry-org' WHERE "organizationId"='telemetry-schema-org'$q$,'OrganizationRagTelemetry_immutable','marker tenant identity immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "OrganizationRagTelemetry" SET "trackingSince"='2025-01-01' WHERE "organizationId"='telemetry-schema-org'$q$,'OrganizationRagTelemetry_immutable','tracking start immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "OrganizationRagTelemetry" SET "lastRecordedAt"='2025-01-01' WHERE "organizationId"='telemetry-schema-org'$q$,'OrganizationRagTelemetry_order','marker ordered');
SELECT pg_temp.telemetry_reject($q$UPDATE "OrganizationRagTelemetry" SET "lastKnownGapReportedAt"='2027-01-01' WHERE "organizationId"='telemetry-schema-org'$q$,'OrganizationRagTelemetry_shape','gap timestamp within observation range');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "formatVersion"=2 WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_immutable','hour format immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET provider='OPENAI' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_immutable','hour provider immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET workload='INDEX_STRUCTURE' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_immutable','hour workload immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "organizationId"='foreign-telemetry-org' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_immutable','hour tenant identity immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "bucketStart"='2026-01-02T00:00Z' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_immutable','hour bucket immutable');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagOperationalHour" SET "lastRecordedAt"='2025-01-01' WHERE "organizationId"='telemetry-schema-org'$q$,'RagOperationalHour_order','hour ordered');
SELECT pg_temp.telemetry_reject($q$INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt") VALUES ('telemetry-schema-org','2026-01-03T00:01Z','EXTRACTION','NONE','2026-01-03T01:00Z')$q$,'RagOperationalHour_identity','UTC aligned bucket');
SELECT pg_temp.telemetry_reject($q$INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt") VALUES ('telemetry-schema-org','infinity','EXTRACTION','NONE','infinity')$q$,'RagOperationalHour_identity','finite observation time');
SET LOCAL TIME ZONE 'Pacific/Honolulu';
INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt") VALUES ('telemetry-schema-org','2026-01-03T00:00Z','EXTRACTION','NONE','2026-01-03T01:00Z');
INSERT INTO telemetry_schema_proofs VALUES('UTC alignment independent of session zone');

SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanOutcome"='RETURNED' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','no invented worker completion');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"=now() WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','finish requires outcome not nullable CHECK bypass');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastFinishedScanDurationMicros"=0 WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','duration cannot invent finish');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"=now(),"lastScanOutcome"='THREW' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','throw requires safe failure');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"=now(),"lastScanOutcome"='RETURNED',"lastSafeFailure"='UNKNOWN' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','returned cannot retain failure');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"='2026-01-01T00:00Z',"lastFinishedScanStartObservedAt"='2026-01-01T00:01Z',"lastScanOutcome"='RETURNED' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','own associated start precedes finish');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"=now(),"lastFinishedScanDurationMicros"=-1,"lastScanOutcome"='RETURNED' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_shape','negative worker duration');
UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"='2026-01-01T00:01Z',"lastScanOutcome"='THREW',"lastSafeFailure"='UNKNOWN' WHERE lane='INDEXING';
-- Independent latest start may be later than the latest finish under replicas.
UPDATE "RagWorkerLaneObservation" SET "lastScanStartObservedAt"='2026-01-01T00:02Z',"lastHeartbeatObservedAt"='2026-01-01T00:03Z' WHERE lane='INDEXING';
DO $$ BEGIN IF (SELECT "lastSafeFailure" FROM "RagWorkerLaneObservation" WHERE lane='INDEXING')<>'UNKNOWN' THEN RAISE EXCEPTION 'Heartbeat cleared scan error'; END IF; INSERT INTO telemetry_schema_proofs VALUES('independent replicas and unknown own start/duration valid'); END $$;
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastHeartbeatObservedAt"=NULL WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_order','heartbeat cannot erase evidence');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"='2025-01-01' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_order','finish cannot move backwards');
SELECT pg_temp.telemetry_reject($q$UPDATE "RagWorkerLaneObservation" SET lane='DOCUMENTS' WHERE lane='INDEXING'$q$,'RagWorkerLaneObservation_immutable','lane identity immutable');
UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"='2026-01-01T00:04Z',"lastScanOutcome"='RETURNED',"lastSafeFailure"=NULL,"lastFinishedScanDurationMicros"=0 WHERE lane='INDEXING';
INSERT INTO telemetry_schema_proofs VALUES('atomic real finish shape may clear prior failure with zero measured duration');

SELECT pg_temp.telemetry_reject($q$INSERT INTO "OrganizationRagTelemetry" ("organizationId","trackingSince","lastRecordedAt") VALUES ('missing-telemetry-organization',now(),now())$q$,'OrganizationRagTelemetry_organizationId_fkey','no telemetry marker recreates absent organization');
DELETE FROM organization WHERE id='telemetry-schema-org';
DO $$ BEGIN
    IF EXISTS(SELECT FROM "OrganizationRagTelemetry" WHERE "organizationId"='telemetry-schema-org') OR EXISTS(SELECT FROM "RagOperationalHour" WHERE "organizationId"='telemetry-schema-org') THEN RAISE EXCEPTION 'Telemetry metadata cascade failed'; END IF;
    IF NOT EXISTS(SELECT FROM "RagWorkerLaneObservation" WHERE lane='INDEXING') THEN RAISE EXCEPTION 'Global lane was incorrectly organization-owned'; END IF;
    INSERT INTO telemetry_schema_proofs VALUES('organization cascade preserves independent global lane');
    RAISE NOTICE 'Observability schema constraint proofs: %',(SELECT count(*) FROM telemetry_schema_proofs);
END $$;
ROLLBACK;
