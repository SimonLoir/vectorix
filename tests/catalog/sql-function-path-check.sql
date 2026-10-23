-- NOT_RUN until the reviewed forward function-path migration is applied.
-- All rows, instrumentation and temporary shadows are rolled back. This tests
-- SQL lookup/integrity behavior, not real provider/publication/cleanup success.
BEGIN;
DO $$ BEGIN
    IF current_database() NOT IN ('vectorix_catalog_test','vectorix_upgrade_test','vectorix_sql_function_path_test') THEN
        RAISE EXCEPTION 'Function-path proofs require an owned disposable _test database';
    END IF;
END $$;
\ir sql-function-path-fixture.sql
CREATE TEMP TABLE sql_path_proofs (name text PRIMARY KEY);
CREATE TEMP TABLE sql_path_touches (candidate_id text NOT NULL);

-- No helper has a function-local search_path: real production calls/mutations
-- below inherit the deliberately empty caller path. Test tables are qualified.
CREATE FUNCTION pg_temp.sql_path_reject(statement text, expected_constraint text, proof text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_constraint text;
BEGIN
    BEGIN
        EXECUTE statement;
        SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN integrity_constraint_violation THEN
        GET STACKED DIAGNOSTICS actual_constraint=CONSTRAINT_NAME;
        IF actual_constraint IS DISTINCT FROM expected_constraint THEN
            RAISE EXCEPTION 'Wrong function-path integrity constraint';
        END IF;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO pg_temp.sql_path_proofs VALUES(proof);
        RETURN;
    END;
    RAISE EXCEPTION 'Invalid function-path mutation was accepted';
END;
$$;
CREATE FUNCTION pg_temp.sql_path_phase(samples text,total text,maximum text,slot integer,count_value text) RETURNS jsonb LANGUAGE sql AS $$
    SELECT jsonb_build_object('samples',samples,'sumMicros',total,'maxMicros',maximum,
        'buckets',(SELECT jsonb_agg(CASE WHEN n=slot THEN count_value ELSE '0' END ORDER BY n) FROM generate_series(0,15) n))
$$;
CREATE FUNCTION pg_temp.sql_path_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO pg_temp.sql_path_touches VALUES(NEW.id);
    RETURN NEW;
END;
$$;
CREATE TRIGGER sql_path_test_touch AFTER UPDATE ON public."IndexedDocument"
FOR EACH ROW EXECUTE FUNCTION pg_temp.sql_path_touch();

-- Populated pg_temp shadows would either bypass an owner touch or redirect a
-- guard if production functions inherited the caller's temporary namespace.
CREATE TEMP TABLE "IndexedDocument" (LIKE public."IndexedDocument" INCLUDING DEFAULTS);
INSERT INTO pg_temp."IndexedDocument" SELECT * FROM public."IndexedDocument" WHERE id='parent-schema-a';
UPDATE pg_temp."IndexedDocument" SET status='CLEANED',"updatedAt"='2000-01-01T00:00Z';
CREATE TEMP TABLE "IndexGeneration" (LIKE public."IndexGeneration" INCLUDING DEFAULTS);
INSERT INTO pg_temp."IndexGeneration" SELECT * FROM public."IndexGeneration" WHERE id='00000000-0000-4000-8000-000000000091';
UPDATE pg_temp."IndexGeneration" SET "parentContextVersion"=NULL;
CREATE TEMP TABLE "Chunk" (LIKE public."Chunk" INCLUDING DEFAULTS);
CREATE TEMP TABLE organization (LIKE public.organization INCLUDING DEFAULTS);
CREATE TEMP TABLE changed_new ("indexedDocumentId" text NOT NULL);
CREATE TEMP TABLE changed_old ("indexedDocumentId" text NOT NULL);
INSERT INTO pg_temp.changed_new VALUES('foreign-temporary-owner');
INSERT INTO pg_temp.changed_old VALUES('foreign-temporary-owner');

-- The sibling upgrade checker snapshots actual pre-migration pg_proc metadata
-- and verifies the only change is proconfig. This fresh-install inventory
-- separately checks all 28 explicit signatures and their invoker/local paths.
CREATE TEMP TABLE sql_path_expected (signature text PRIMARY KEY);
INSERT INTO pg_temp.sql_path_expected VALUES
    ('public.vectorix_chunk_lexical()'),
    ('public.vectorix_embedding_work_update()'),
    ('public.vectorix_parent_candidate_delete()'),
    ('public.vectorix_parent_candidate_layout(public."IndexedDocument")'),
    ('public.vectorix_parent_candidate_state()'),
    ('public.vectorix_parent_chunk_delete_touch()'),
    ('public.vectorix_parent_chunk_insert_touch()'),
    ('public.vectorix_parent_chunk_link()'),
    ('public.vectorix_parent_chunk_row()'),
    ('public.vectorix_parent_chunk_touch()'),
    ('public.vectorix_parent_generation_delete()'),
    ('public.vectorix_parent_generation_identity()'),
    ('public.vectorix_parent_offset_valid(jsonb)'),
    ('public.vectorix_parent_revision_identity()'),
    ('public.vectorix_parent_spans_valid(jsonb,integer,integer)'),
    ('public.vectorix_rag_organization_delete()'),
    ('public.vectorix_rag_organization_lock()'),
    ('public.vectorix_semantic_history_delete()'),
    ('public.vectorix_semantic_plan_payload_valid(public."SemanticChunkPlan")'),
    ('public.vectorix_semantic_plan_update()'),
    ('public.vectorix_semantic_ranges_valid(jsonb,integer,boolean)'),
    ('public.vectorix_semantic_scores_valid(jsonb)'),
    ('public.vectorix_telemetry_decimal(jsonb)'),
    ('public.vectorix_telemetry_failures(jsonb)'),
    ('public.vectorix_telemetry_identity()'),
    ('public.vectorix_telemetry_merge_failures(jsonb,jsonb)'),
    ('public.vectorix_telemetry_merge_phases(jsonb,jsonb,public."RagOperationalWorkload")'),
    ('public.vectorix_telemetry_phases(jsonb,public."RagOperationalWorkload")');

-- Match pg_dump/pg_restore's exact empty GUC value. SET's identifier-list
-- grammar can serialize the empty quoted identifier as `""` instead.
SELECT pg_catalog.set_config('search_path','',true);
DO $$
DECLARE total integer;
BEGIN
    IF current_setting('search_path')<>'' THEN RAISE EXCEPTION 'Caller path is not empty'; END IF;
    SELECT count(*) INTO total FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proname LIKE 'vectorix\_%' ESCAPE '\';
    IF total<>28 OR (SELECT count(*) FROM pg_temp.sql_path_expected)<>28 THEN RAISE EXCEPTION 'Wrong fixed function inventory'; END IF;
    IF EXISTS (
        SELECT FROM pg_temp.sql_path_expected expected
        LEFT JOIN pg_catalog.pg_proc p ON p.oid=pg_catalog.to_regprocedure(expected.signature)
        LEFT JOIN pg_catalog.pg_language language ON language.oid=p.prolang
        WHERE p.oid IS NULL OR p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public, pg_temp']
            OR p.prosecdef OR p.proleakproof OR p.proisstrict OR p.proretset OR p.prokind<>'f'
            OR language.lanname<>'plpgsql' OR p.procost<>100 OR p.prorows<>0
            OR p.proowner<>(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)
            OR p.proacl IS NOT NULL
    ) THEN RAISE EXCEPTION 'Function-path migration changed more than the reviewed local setting'; END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('28 explicit invoker functions retain source and attributes');
END $$;

DO $$
DECLARE first_phase jsonb; second_phase jsonb; merged jsonb;
BEGIN
    first_phase:=jsonb_build_object('PLAN',pg_temp.sql_path_phase('1','1001','1001',1,'1'));
    second_phase:=jsonb_build_object('PLAN',pg_temp.sql_path_phase('1','5000','5000',1,'1'));
    IF NOT public.vectorix_telemetry_decimal('"12"') OR public.vectorix_telemetry_decimal('"01"')
        OR NOT public.vectorix_telemetry_phases(first_phase,'INDEX_SEMANTIC'::public."RagOperationalWorkload")
        OR public.vectorix_telemetry_phases(jsonb_build_object('PLAN',pg_temp.sql_path_phase('1','1001','1001',1,'2')),'INDEX_SEMANTIC'::public."RagOperationalWorkload")
        OR NOT public.vectorix_telemetry_failures('{"OTHER":"2"}') OR public.vectorix_telemetry_failures('{"OTHER":"-1"}')
    THEN RAISE EXCEPTION 'Nested validators failed under an empty caller path'; END IF;
    merged:=public.vectorix_telemetry_merge_phases(first_phase,second_phase,'INDEX_SEMANTIC'::public."RagOperationalWorkload");
    IF merged<>jsonb_build_object('PLAN',pg_temp.sql_path_phase('2','6001','5000',1,'2'))
        OR public.vectorix_telemetry_merge_failures('{"OTHER":"2"}','{"OTHER":"3","LEASE":"1"}')<>'{"OTHER":"5","LEASE":"1"}'::jsonb
    THEN RAISE EXCEPTION 'Nested merges lost numeric observations'; END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('populated telemetry validators and merges use their own path');
END $$;
SELECT pg_temp.sql_path_reject($q$SELECT public.vectorix_telemetry_merge_phases('{}','{"PLAN":{}}','INDEX_SEMANTIC'::public."RagOperationalWorkload")$q$,'RagOperationalHour_phases','malformed phase merge remains rejected');
SELECT pg_temp.sql_path_reject($q$SELECT public.vectorix_telemetry_merge_failures('{}','{"OTHER":"01"}')$q$,'RagOperationalHour_failures','malformed failure merge remains rejected');
INSERT INTO public."OrganizationRagTelemetry" ("organizationId","trackingSince","lastRecordedAt")
VALUES ('parent-schema-org','2026-01-01T00:00Z','2026-01-01T00:01Z');
INSERT INTO public."RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt","phaseStats","failureCounts")
VALUES ('parent-schema-org','2026-01-01T00:00Z','INDEX_SEMANTIC','OLLAMA','2026-01-01T00:01Z',
    jsonb_build_object('PLAN',pg_temp.sql_path_phase('1','1001','1001',1,'1')),'{"OTHER":"1"}');
SELECT pg_temp.sql_path_reject($q$UPDATE public."RagOperationalHour" SET "failureCounts"='{"OTHER":"01"}' WHERE "organizationId"='parent-schema-org'$q$,'RagOperationalHour_failures','real populated telemetry CHECK remains enforced');

-- This is a real non-CLEANED plan INSERT/CHECK and checkpoint UPDATE. A cleaned
-- plan would return before the nested range/score validators and miss the bug.
INSERT INTO public."SemanticChunkPlan" ("indexedDocumentId","organizationId","generationId","configurationRevision","chunkerVersion","unitizerVersion","sourceHash","profileHash","modelIdentity","unitManifestHash","unitCount","unitRanges","storedBytes","reservedBytes","updatedAt")
VALUES ('sql-path-semantic-candidate','parent-schema-org','00000000-0000-4000-8000-000000000095',1,'semantic-utf8-v1','semantic-units-utf8-v1',repeat('a',64),repeat('b',64),repeat('d',64),repeat('e',64),2,'[{"ordinal":0,"start":0,"end":6},{"ordinal":1,"start":7,"end":12}]',1000,0,now());
DO $$ BEGIN
    IF NOT (SELECT public.vectorix_semantic_plan_payload_valid(plan) FROM public."SemanticChunkPlan" plan WHERE "indexedDocumentId"='sql-path-semantic-candidate') THEN
        RAISE EXCEPTION 'Non-cleaned semantic payload was rejected';
    END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('non-cleaned semantic INSERT reaches nested range and score CHECKs');
END $$;
SELECT pg_temp.sql_path_reject($q$INSERT INTO public."SemanticChunkPlan" SELECT (jsonb_populate_record(NULL::public."SemanticChunkPlan",to_jsonb(plan)||'{"indexedDocumentId":"sql-path-semantic-invalid","unitRanges":[{"ordinal":0,"start":0.5,"end":6},{"ordinal":1,"start":7,"end":12}]}')).* FROM public."SemanticChunkPlan" plan WHERE "indexedDocumentId"='sql-path-semantic-candidate'$q$,'SemanticChunkPlan_bounds_check','fractional semantic ranges remain rejected');
UPDATE public."SemanticChunkPlan" SET "completedUnits"=1,"lastUnitVector"=decode('0000803f00000000','hex') WHERE "indexedDocumentId"='sql-path-semantic-candidate';
SELECT pg_temp.sql_path_reject($q$UPDATE public."SemanticChunkPlan" SET "completedUnits"=2,"boundaryScores"='[2000001]',"lastUnitVector"=decode('000000000000803f','hex') WHERE "indexedDocumentId"='sql-path-semantic-candidate'$q$,'SemanticChunkPlan_bounds_check','out-of-range semantic distance remains rejected');

TRUNCATE pg_temp.sql_path_touches;
-- One real multirow INSERT invokes the actual row and statement triggers. The
-- unqualified executor transition aliases must beat the populated temp shadows.
INSERT INTO public."Chunk" (id,"organizationId","generationId","indexedDocumentId",ordinal,kind,text,"textHash","embeddingInputHash","sourceSpans","startOffset","endOffset",language,"tokenCount","parentId")
SELECT 'sql-path-'||suffix,'parent-schema-org','00000000-0000-4000-8000-000000000091','parent-schema-a',position,row_kind::public."RagChunkKind",content,repeat('a',64),CASE WHEN row_kind='CHILD' THEN repeat('b',64) END,
    jsonb_build_array(jsonb_build_object('source',jsonb_build_object('kind','text','index',0,'start',0,'end',100),'start',first_offset,'end',last_offset)),first_offset,last_offset,'FR',1,parent_id
FROM (VALUES ('parent',2,'PARENT','Alpha. Beta.',0,12,NULL),('child-0',0,'CHILD','Alpha.',0,6,'sql-path-parent'),('child-1',1,'CHILD','Beta.',7,12,'sql-path-parent')) fixture_rows(suffix,position,row_kind,content,first_offset,last_offset,parent_id);
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DO $$ BEGIN
    IF (SELECT count(*) FROM pg_temp.sql_path_touches WHERE candidate_id='parent-schema-a')<>1
        OR (SELECT count(*) FROM pg_temp.sql_path_touches)<>1
        OR (SELECT "updatedAt" FROM pg_temp."IndexedDocument" WHERE id='parent-schema-a')<>'2000-01-01T00:00Z'::timestamptz
        OR EXISTS(SELECT FROM pg_temp."Chunk")
    THEN RAISE EXCEPTION 'INSERT transition binding or application-table lookup was redirected'; END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('INSERT transition alias and public owner survive temp shadows');
END $$;
TRUNCATE pg_temp.sql_path_touches;
UPDATE public."Chunk" SET text=text WHERE "indexedDocumentId"='parent-schema-a';
DO $$ BEGIN
    IF (SELECT count(*) FROM pg_temp.sql_path_touches WHERE candidate_id='parent-schema-a')<>1 OR (SELECT count(*) FROM pg_temp.sql_path_touches)<>1 THEN
        RAISE EXCEPTION 'UPDATE old/new transition aliases were not the actual statement rows';
    END IF;
    IF EXISTS(SELECT FROM public."Chunk" WHERE kind='PARENT' AND ("lexicalFrench"<>''::tsvector OR "lexicalEnglish"<>''::tsvector OR "lexicalSimple"<>''::tsvector))
        OR NOT EXISTS(SELECT FROM public."Chunk" WHERE kind='CHILD' AND "lexicalSimple"<>''::tsvector) THEN
        RAISE EXCEPTION 'Lexical ownership changed under empty caller path';
    END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('UPDATE transition aliases preserve one real owner touch');
END $$;
SELECT pg_temp.sql_path_reject($q$INSERT INTO public."Chunk" SELECT (jsonb_populate_record(NULL::public."Chunk",to_jsonb(child)||'{"id":"sql-path-invalid-link","ordinal":3,"endOffset":13,"sourceSpans":[{"source":{"kind":"text","index":0,"start":0,"end":100},"start":0,"end":13}]}')).* FROM public."Chunk" child WHERE id='sql-path-child-0'$q$,'Chunk_parent_containment','deferred parent containment remains enforced');
UPDATE public."IndexedDocument" SET status='SEALED',"manifestHash"=repeat('c',64) WHERE id='parent-schema-a';
SELECT pg_temp.sql_path_reject($q$UPDATE public."Chunk" SET text=text WHERE "indexedDocumentId"='parent-schema-a'$q$,'Chunk_layout_frozen','sealed layout still rejects no-op updates');
SELECT pg_temp.sql_path_reject($q$DELETE FROM public."Chunk" WHERE "indexedDocumentId"='parent-schema-a'$q$,'Chunk_layout_frozen','sealed layout still rejects physical deletion');

-- All acknowledgments below are synthetic transition-shape probes. They do not
-- represent an external vector purge, native request, source read or elapsed TTL.
UPDATE public."IndexedDocument" SET status='RETIRED' WHERE id='parent-schema-a';
UPDATE public."IndexedDocument" SET status='CLEANING' WHERE id='parent-schema-a';
TRUNCATE pg_temp.sql_path_touches;
DELETE FROM public."Chunk" WHERE "indexedDocumentId"='parent-schema-a';
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
DO $$ BEGIN
    IF EXISTS(SELECT FROM public."Chunk" WHERE "indexedDocumentId"='parent-schema-a')
        OR (SELECT count(*) FROM pg_temp.sql_path_touches WHERE candidate_id='parent-schema-a')<>1 OR (SELECT count(*) FROM pg_temp.sql_path_touches)<>1
    THEN RAISE EXCEPTION 'DELETE transition alias did not touch the real CLEANING owner'; END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('DELETE transition alias and legal cleanup survive temp shadows');
END $$;
UPDATE public."IndexedDocument" SET status='CLEANED',"materializedChunks"=0 WHERE id='parent-schema-a';
-- Cached generation status is deliberately clean: the unfinished semantic row
-- itself must still block the native-shaped delete. No accounting cache exists.
UPDATE public."IndexGeneration" SET status='CLEANED' WHERE "organizationId"='parent-schema-org';
SELECT pg_temp.sql_path_reject($q$DELETE FROM public.member WHERE "organizationId"='parent-schema-org'; DELETE FROM public.organization WHERE id='parent-schema-org'$q$,'organization_rag_cleanup_required','native-shaped delete still blocks unfinished semantic history');
DO $$ BEGIN
    IF NOT EXISTS(SELECT FROM public.member WHERE id='parent-schema-member') THEN RAISE EXCEPTION 'Late guard lost native membership rollback'; END IF;
END $$;
UPDATE public."SemanticChunkPlan" SET state='CLEANED',"unitRanges"='[]',"boundaryScores"='[]',"lastUnitVector"=NULL,"completedUnits"=0,"thresholdDistance"=NULL,"storedBytes"=0,"reservedBytes"=0,"reservedPreparedBytes"=0,"reservedBatches"=0,"cleanedAt"=now() WHERE "indexedDocumentId"='sql-path-semantic-candidate';
UPDATE public."IndexedDocument" SET status='CLEANED',"materializedChunks"=0 WHERE "collectionId"='sql-path-semantic-collection';
UPDATE public."IndexGeneration" SET status='CLEANED' WHERE "organizationId"='parent-schema-org';
DELETE FROM public.organization WHERE id='parent-schema-org';
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
    IF EXISTS(SELECT FROM public.member WHERE id='parent-schema-member') OR EXISTS(SELECT FROM public."Chunk" WHERE "organizationId"='parent-schema-org') THEN
        RAISE EXCEPTION 'Fully cleaned native metadata cascade failed';
    END IF;
    INSERT INTO pg_temp.sql_path_proofs VALUES('fully cleaned native cascade retains its original guards');
    RAISE NOTICE 'Function-path SQL proofs: %',(SELECT count(*) FROM pg_temp.sql_path_proofs);
END $$;
ROLLBACK;
