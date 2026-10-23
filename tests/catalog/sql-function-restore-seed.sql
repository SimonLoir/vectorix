-- Committed synthetic rows for an actual disposable pg_dump/pg_restore proof.
-- These are database shape fixtures, never real provider/vector/object success.
BEGIN;
DO $$ BEGIN
    IF current_database() NOT IN ('vectorix_upgrade_test','vectorix_sql_function_restore_source_test') THEN
        RAISE EXCEPTION 'Populated restore seed requires an owned disposable _test source';
    END IF;
END $$;
\ir sql-function-path-fixture.sql
SELECT pg_temp.parent_fill('parent-schema-a');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
-- Application-only seal: no vectorSealedAt/publishedAt is invented.
UPDATE public."IndexedDocument" SET status='SEALED',"manifestHash"=repeat('c',64) WHERE id='parent-schema-a';
INSERT INTO public."CollectionIndexAccounting" ("collectionId","organizationId","retainedChunks","updatedAt")
VALUES ('parent-schema-collection','parent-schema-org',2,now());
INSERT INTO public."SemanticChunkPlan" ("indexedDocumentId","organizationId","generationId","configurationRevision","chunkerVersion","unitizerVersion","sourceHash","profileHash","modelIdentity","unitManifestHash","unitCount","unitRanges","completedUnits","boundaryScores",state,"thresholdDistance","finalRanges","planHash","storedBytes","sealedAt","updatedAt")
VALUES ('sql-path-semantic-candidate','parent-schema-org','00000000-0000-4000-8000-000000000095',1,'semantic-utf8-v1','semantic-units-utf8-v1',repeat('a',64),repeat('b',64),repeat('d',64),repeat('e',64),2,
    '[{"ordinal":0,"start":0,"end":6},{"ordinal":1,"start":7,"end":12}]',2,'[1000000]','READY',1000000,'[{"ordinal":0,"start":0,"end":12}]',repeat('f',64),1000,now(),now());
INSERT INTO public."OrganizationEmbeddingAccounting" ("organizationId","storedPlanBytes","updatedAt")
VALUES ('parent-schema-org',1000,now());
INSERT INTO public."OrganizationRagTelemetry" ("organizationId","trackingSince","lastRecordedAt")
VALUES ('parent-schema-org',date_trunc('hour',now()),now());
INSERT INTO public."RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt","phaseStats","failureCounts")
VALUES ('parent-schema-org',date_trunc('hour',now()),'INDEX_SEMANTIC','OLLAMA',now(),
    '{"PLAN":{"samples":"1","sumMicros":"1001","maxMicros":"1001","buckets":["0","1","0","0","0","0","0","0","0","0","0","0","0","0","0","0"]}}','{"OTHER":"1"}');
DO $$ BEGIN
    IF (SELECT count(*) FROM public."Chunk" WHERE "indexedDocumentId"='parent-schema-a' AND kind='CHILD')<>2
        OR (SELECT count(*) FROM public."Chunk" WHERE "indexedDocumentId"='parent-schema-a' AND kind='PARENT')<>1
        OR NOT EXISTS(SELECT FROM public."SemanticChunkPlan" WHERE "indexedDocumentId"='sql-path-semantic-candidate' AND state='READY' AND "unitCount"=2 AND "completedUnits"=2 AND "boundaryScores"='[1000000]')
        OR NOT EXISTS(SELECT FROM public."RagOperationalHour" WHERE "organizationId"='parent-schema-org' AND "phaseStats"<>'{}' AND "failureCounts"<>'{}')
    THEN RAISE EXCEPTION 'Populated restore source is missing an exercised nested-helper payload'; END IF;
END $$;
COMMIT;
