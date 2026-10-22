-- Every mutation below is synthetic, transaction-local, and rolled back. These
-- direct SQL probes verify constraints unavailable through Prisma's schema DSL.
BEGIN;
DO $$ BEGIN
    IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN
        RAISE EXCEPTION 'Semantic schema probes require a disposable _test database';
    END IF;
END $$;
CREATE TEMP TABLE semantic_schema_proofs (name text PRIMARY KEY);
CREATE FUNCTION pg_temp.semantic_reject(statement text, expected_constraint text, proof text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual_constraint text;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN check_violation OR foreign_key_violation OR unique_violation THEN
        GET STACKED DIAGNOSTICS actual_constraint = CONSTRAINT_NAME;
        IF expected_constraint IS NOT NULL AND actual_constraint IS DISTINCT FROM expected_constraint THEN
            RAISE EXCEPTION 'Wrong semantic constraint: expected %, got %', expected_constraint, actual_constraint;
        END IF;
        INSERT INTO semantic_schema_proofs VALUES (proof);
        RETURN;
    END;
    RAISE EXCEPTION 'Invalid semantic mutation was accepted: %', proof;
END;
$$;
INSERT INTO "user" (id, name, email) VALUES ('semantic-schema-user', 'Synthetic schema owner', 'semantic-schema@example.test');
INSERT INTO organization (id, name, slug, "createdAt") VALUES ('semantic-schema-org', 'Synthetic schema organization', 'semantic-schema-org', now());
INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('semantic-schema-member', 'semantic-schema-org', 'semantic-schema-user', 'owner', now());
INSERT INTO "StorageLocation" (id, "organizationId", fingerprint, endpoint, bucket, region, "forcePathStyle")
VALUES ('semantic-schema-storage', 'semantic-schema-org', 'synthetic-schema-storage', 'https://storage.example.test', 'synthetic-schema', 'us-east-1', true);
INSERT INTO "Document" (id, "organizationId", name, status, "updatedAt", "deletedAt")
VALUES ('semantic-schema-document', 'semantic-schema-org', 'Already purged.txt', 'DELETED', now(), now());
INSERT INTO "DocumentVersion" (id, "organizationId", "documentId", version, "storageLocationId", "objectKey", sha256, "byteSize", "mediaType", status, "discardedAt", "contentState")
VALUES ('semantic-schema-version', 'semantic-schema-org', 'semantic-schema-document', 1, 'semantic-schema-storage', 'synthetic-purged-original', repeat('a', 64), 12, 'text/plain', 'DELETED', now(), 'PURGED');
INSERT INTO "DocumentExtraction" (id, "organizationId", "versionId", "storageLocationId", "objectKey", "byteSize", "extractorVersion", language, "discardedAt")
VALUES ('semantic-schema-extraction', 'semantic-schema-org', 'semantic-schema-version', 'semantic-schema-storage', 'synthetic-purged-text', 12, 'utf8-text-v1', 'fr', now());
INSERT INTO "VectorConnection" (id, "organizationId", "destinationFingerprint") VALUES ('semantic-schema-vector', 'semantic-schema-org', 'synthetic-vector');
INSERT INTO "Collection" (id, "organizationId", name, "updatedAt", "deletedAt") VALUES ('semantic-schema-collection', 'semantic-schema-org', 'Synthetic collection', now(), now());
INSERT INTO "CollectionConfigRevision" (id, "organizationId", "collectionId", revision, "vectorConnectionId", provider, model, dimensions, endpoint, chunking)
VALUES ('semantic-schema-config', 'semantic-schema-org', 'semantic-schema-collection', 1, 'semantic-schema-vector', 'OLLAMA', 'synthetic-model', 2, 'http://embedding.example.test', '{}');
-- The generation is deliberately already CLEANED: independent payload/attempt
-- guards must still protect organization deletion when cached counters are absent.
INSERT INTO "IndexGeneration" (id, "organizationId", "collectionId", "requestId", "configurationRevision", "vectorConnectionId", "vectorSchema", "tableName", "destinationFingerprint", "modelIdentity", "capabilitySnapshot", "chunkerVersion", status, "createdBy", "updatedAt")
VALUES ('00000000-0000-4000-8000-000000000081', 'semantic-schema-org', 'semantic-schema-collection', 'synthetic-schema-request', 1, 'semantic-schema-vector', 'vector_collections', 'g_00000000000040008000000000000081', 'synthetic-vector', repeat('d', 64), '{"dimensions":2}', 'semantic-utf8-v1', 'CLEANED', 'semantic-schema-user', now());
INSERT INTO "IndexedDocument" (id, "organizationId", "collectionId", "generationId", "documentId", "sourceVersionId", "extractionId", "extractorVersion", "buildRevision", "metadataRevision", "sourceChangeSequence", "fileName", "mediaType", language, "documentCreatedAt", "sourceCreatedAt", status, "updatedAt")
VALUES ('semantic-schema-candidate', 'semantic-schema-org', 'semantic-schema-collection', '00000000-0000-4000-8000-000000000081', 'semantic-schema-document', 'semantic-schema-version', 'semantic-schema-extraction', 'utf8-text-v1', 1, 1, 0, 'Already purged.txt', 'text/plain', 'FR', now(), now(), 'CLEANED', now());
INSERT INTO "IndexedDocument" SELECT (jsonb_populate_record(NULL::"IndexedDocument", to_jsonb(candidate) || '{"id":"semantic-schema-invalid-candidate","buildRevision":2}')).*
FROM "IndexedDocument" candidate WHERE id = 'semantic-schema-candidate';
INSERT INTO "OrganizationQuota" ("organizationId", "originalBytes", "storageBytes", "updatedAt") VALUES ('semantic-schema-org', 1000, 2000, now());
INSERT INTO "SemanticChunkPlan" ("indexedDocumentId", "organizationId", "generationId", "configurationRevision", "chunkerVersion", "unitizerVersion", "sourceHash", "profileHash", "modelIdentity", "unitManifestHash", "unitCount", "unitRanges", "storedBytes", "reservedBytes", "updatedAt")
VALUES ('semantic-schema-candidate', 'semantic-schema-org', '00000000-0000-4000-8000-000000000081', 1, 'semantic-utf8-v1', 'semantic-units-utf8-v1', repeat('a', 64), repeat('b', 64), repeat('d', 64), repeat('e', 64), 2, '[{"ordinal":0,"start":0,"end":6},{"ordinal":1,"start":7,"end":12}]', 1000, 1047576, now());
CREATE FUNCTION pg_temp.semantic_insert_plan(changes jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "SemanticChunkPlan" SELECT (jsonb_populate_record(NULL::"SemanticChunkPlan", to_jsonb(plan) || '{"indexedDocumentId":"semantic-schema-invalid-candidate"}' || changes)).*
    FROM "SemanticChunkPlan" plan WHERE "indexedDocumentId" = 'semantic-schema-candidate';
$$;
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"sourceHash":"invalid"}')$q$, 'SemanticChunkPlan_bounds_check', 'hash syntax');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"unitRanges":{}}')$q$, 'SemanticChunkPlan_bounds_check', 'JSON array shape');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"unitRanges":[{"ordinal":0,"start":0,"end":6,"extra":1},{"ordinal":1,"start":7,"end":12}]}')$q$, 'SemanticChunkPlan_bounds_check', 'JSON range keys');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"unitRanges":[{"ordinal":0,"start":0.5,"end":6},{"ordinal":1,"start":7,"end":12}]}')$q$, 'SemanticChunkPlan_bounds_check', 'integer canonical offsets');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"unitRanges":[{"ordinal":0,"start":0,"end":8},{"ordinal":1,"start":7,"end":12}]}')$q$, 'SemanticChunkPlan_bounds_check', 'ordered nonoverlapping unit ranges');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"completedUnits":2,"boundaryScores":[2000001],"lastUnitVector":"\\x0000803f00000000"}')$q$, 'SemanticChunkPlan_bounds_check', 'score maximum');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan('{"state":"READY","completedUnits":2,"boundaryScores":[1000000],"thresholdDistance":1000000,"finalRanges":[],"planHash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","sealedAt":"2026-10-22T00:00:00Z","reservedBytes":0}')$q$, 'SemanticChunkPlan_bounds_check', 'useful READY plan requires final ranges');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_plan(jsonb_build_object('state','READY','completedUnits',2,'boundaryScores','[1000000]'::jsonb,'thresholdDistance',1000000,'finalRanges',(SELECT jsonb_agg(jsonb_build_object('ordinal',i,'start',i*2,'end',i*2+1)) FROM generate_series(0,29999) i),'planHash',repeat('f',64),'sealedAt',now(),'storedBytes',1048576,'reservedBytes',0))$q$, 'SemanticChunkPlan_bounds_check', 'absolute compact payload byte ceiling');
SELECT pg_temp.semantic_reject('UPDATE "OrganizationQuota" SET "semanticUnitsPerDocument" = 8193 WHERE "organizationId" = ''semantic-schema-org''', 'OrganizationQuota_semantic_limits_check', 'unit hard ceiling');
SELECT pg_temp.semantic_reject('UPDATE "OrganizationQuota" SET "embeddingBatchesPerCandidate" = 4097 WHERE "organizationId" = ''semantic-schema-org''', 'OrganizationQuota_semantic_limits_check', 'logical batch hard ceiling');
SELECT pg_temp.semantic_reject('UPDATE "OrganizationQuota" SET "embeddingOutstandingBatches" = 1 WHERE "organizationId" = ''semantic-schema-org''', 'OrganizationQuota_semantic_limits_check', 'organization complete allowance capacity');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "sourceHash" = repeat(''f'',64) WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'immutable source binding');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "unitRanges" = ''[]'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'immutable unit geometry');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "completedUnits" = 1,"lastUnitVector" = decode(''0000803f'',''hex'') WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_generation_binding', 'checkpoint dimensions');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "completedUnits" = 1 WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_bounds_check', 'checkpoint required for accepted prefix');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "boundaryScores" = ''[0.5]'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_bounds_check', 'integer distance bounds');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "storedBytes" = 1 WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_bounds_check', 'payload cannot be undercharged');
SELECT pg_temp.semantic_reject('DELETE FROM organization WHERE id = ''semantic-schema-org''', 'organization_rag_cleanup_required', 'actual plan blocks deletion without accounting');
-- Mirror Better Auth's members-first native transaction. The late guard must
-- abort both writes, retaining membership after the subtransaction rolls back.
DO $$ BEGIN
    BEGIN
        DELETE FROM member WHERE "organizationId" = 'semantic-schema-org';
        DELETE FROM organization WHERE id = 'semantic-schema-org';
        RAISE EXCEPTION 'Native-shaped delete unexpectedly succeeded';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
    IF NOT EXISTS (SELECT FROM member WHERE id = 'semantic-schema-member') THEN RAISE EXCEPTION 'Late cleanup guard lost native membership rollback'; END IF;
    INSERT INTO semantic_schema_proofs VALUES ('members-first native-shaped rollback');
END $$;
UPDATE "SemanticChunkPlan" SET "completedUnits" = 1, "lastUnitVector" = decode('0000803f00000000','hex') WHERE "indexedDocumentId" = 'semantic-schema-candidate';
UPDATE "SemanticChunkPlan" SET "completedUnits" = 2, "boundaryScores" = '[1000000]', "lastUnitVector" = decode('000000000000803f','hex') WHERE "indexedDocumentId" = 'semantic-schema-candidate';
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "completedUnits" = 1,"boundaryScores" = ''[]'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'accepted cursor cannot rewind');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "boundaryScores" = ''[9]'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'accepted score cannot change');
UPDATE "SemanticChunkPlan" SET state = 'READY', "lastUnitVector" = NULL, "thresholdDistance" = 1000000, "finalRanges" = '[{"ordinal":0,"start":0,"end":12}]', "planHash" = repeat('f',64), "sealedAt" = now(), "reservedBytes" = 0 WHERE "indexedDocumentId" = 'semantic-schema-candidate';
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET "finalRanges" = ''[]'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'sealed final ranges cannot change');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET state = ''PLANNING'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'sealed plan cannot reopen');
INSERT INTO "EmbeddingWorkAttempt" (id, "organizationId", "generationId", "indexedDocumentId", purpose, "operationKey", "batchOrdinal", "attemptNumber", "inputHash", "inputCount", "preparedInputBytes", "taskId", "leaseEpoch", state, "reservedPreparedBytes", "reservedBatches", "dispatchedPreparedBytes", "dispatchedBatches", "dispatchStartedAt", "deadlineAt", "updatedAt")
VALUES ('semantic-schema-attempt', 'semantic-schema-org', '00000000-0000-4000-8000-000000000081', 'semantic-schema-candidate', 'BOUNDARY', 'synthetic-boundary-operation', 0, 1, repeat('a',64), 2, 12, 'diagnostic-task-id-without-fk', 1, 'IN_FLIGHT', 12, 1, 12, 1, now(), now()+interval '120 seconds', now());
CREATE FUNCTION pg_temp.semantic_insert_work(changes jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "EmbeddingWorkAttempt" SELECT (jsonb_populate_record(NULL::"EmbeddingWorkAttempt", to_jsonb(work) || '{"id":"semantic-schema-invalid-attempt","attemptNumber":2}' || changes)).*
    FROM "EmbeddingWorkAttempt" work WHERE id = 'semantic-schema-attempt';
$$;
INSERT INTO organization (id, name, slug, "createdAt") VALUES ('semantic-schema-foreign', 'Foreign schema organization', 'semantic-schema-foreign', now());
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"organizationId":"semantic-schema-foreign"}')$q$, 'EmbeddingWorkAttempt_organizationId_generationId_indexedDo_fkey', 'candidate organization composite scope');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"attemptNumber":1}')$q$, 'EmbeddingWorkAttempt_operation_attempt_key', 'unique logical attempt identity');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"inputCount":2049}')$q$, 'EmbeddingWorkAttempt_bounds_check', 'native batch count ceiling');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"preparedInputBytes":2097153,"reservedPreparedBytes":2097153,"dispatchedPreparedBytes":2097153}')$q$, 'EmbeddingWorkAttempt_bounds_check', 'native prepared byte ceiling');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"state":"SUCCEEDED","reservedPreparedBytes":0,"reservedBatches":0,"successfulRequests":1,"estimatedInputTokens":3,"billedInputTokens":"NaN","usageRecordedAt":"2026-10-22T00:00:00Z","settledAt":"2026-10-22T00:00:00Z"}')$q$, 'EmbeddingWorkAttempt_bounds_check', 'per-attempt NaN rejected');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"state":"SUCCEEDED","reservedPreparedBytes":0,"reservedBatches":0,"successfulRequests":1,"estimatedInputTokens":3,"billedInputTokens":"Infinity","usageRecordedAt":"2026-10-22T00:00:00Z","settledAt":"2026-10-22T00:00:00Z"}')$q$, 'EmbeddingWorkAttempt_bounds_check', 'per-attempt infinity rejected');
SELECT pg_temp.semantic_reject($q$SELECT pg_temp.semantic_insert_work('{"state":"SUCCEEDED","reservedPreparedBytes":0,"reservedBatches":0,"successfulRequests":null,"estimatedInputTokens":3,"usageRecordedAt":"2026-10-22T00:00:00Z","settledAt":"2026-10-22T00:00:00Z"}')$q$, 'EmbeddingWorkAttempt_bounds_check', 'successful usage requires explicit one logical batch');
SELECT pg_temp.semantic_reject('UPDATE "EmbeddingWorkAttempt" SET "inputHash" = repeat(''b'',64) WHERE id = ''semantic-schema-attempt''', 'EmbeddingWorkAttempt_immutable', 'immutable logical input identity');
SELECT pg_temp.semantic_reject('UPDATE "EmbeddingWorkAttempt" SET state = ''UNCERTAIN'',"settledAt" = now(),"uncertainAt" = now() WHERE id = ''semantic-schema-attempt''', 'EmbeddingWorkAttempt_bounds_check', 'settlement must release attempt capacity');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET state = ''CLEANED'',"unitRanges" = ''[]'',"boundaryScores" = ''[]'',"completedUnits" = 0,"lastUnitVector" = NULL,"finalRanges" = NULL,"thresholdDistance" = NULL,"storedBytes" = 0,"reservedBytes" = 0,"cleanedAt" = now() WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_work_pending', 'inflight work blocks plan cleanup');
UPDATE "EmbeddingWorkAttempt" SET state = 'UNCERTAIN', "reservedPreparedBytes" = 0, "reservedBatches" = 0, "uncertainAt" = now(), "settledAt" = now(), "outcomeCode" = 'PROVIDER_TIMEOUT' WHERE id = 'semantic-schema-attempt';
UPDATE "SemanticChunkPlan" SET state = 'CLEANED', "unitRanges" = '[]', "boundaryScores" = '[]', "completedUnits" = 0, "lastUnitVector" = NULL, "finalRanges" = NULL, "thresholdDistance" = NULL, "storedBytes" = 0, "reservedBytes" = 0, "cleanedAt" = now() WHERE "indexedDocumentId" = 'semantic-schema-candidate';
INSERT INTO semantic_schema_proofs VALUES ('cleaned payload permits retained nonzero unit metadata');
-- Late usage after content cleanup is allowed; it cannot reacquire reservation.
UPDATE "EmbeddingWorkAttempt" SET state = 'SUCCEEDED', "successfulRequests" = 1, "estimatedInputTokens" = 3, "providerInputTokens" = NULL, "billedInputTokens" = 0.5, "usageRecordedAt" = now(), "settledAt" = now(), "outcomeCode" = NULL WHERE id = 'semantic-schema-attempt';
INSERT INTO semantic_schema_proofs VALUES ('late validated usage after cleaned plan');
SELECT pg_temp.semantic_reject('UPDATE "EmbeddingWorkAttempt" SET "billedInputTokens" = 1 WHERE id = ''semantic-schema-attempt''', 'EmbeddingWorkAttempt_immutable', 'observed selected usage immutable');
SELECT pg_temp.semantic_reject('UPDATE "EmbeddingWorkAttempt" SET state = ''IN_FLIGHT'',"reservedPreparedBytes" = 12,"reservedBatches" = 1,"settledAt" = NULL WHERE id = ''semantic-schema-attempt''', 'EmbeddingWorkAttempt_immutable', 'settled attempt cannot reacquire reservation');
SELECT pg_temp.semantic_reject('DELETE FROM "EmbeddingWorkAttempt" WHERE id = ''semantic-schema-attempt''', 'semantic_history_parent_required', 'work history cannot reset candidate budget');
SELECT pg_temp.semantic_reject('DELETE FROM "SemanticChunkPlan" WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'semantic_history_parent_required', 'cleaned plan history cannot be reset');
SELECT pg_temp.semantic_reject('UPDATE "SemanticChunkPlan" SET state = ''PLANNING'' WHERE "indexedDocumentId" = ''semantic-schema-candidate''', 'SemanticChunkPlan_immutable', 'cleaned plan cannot revive');
INSERT INTO "OrganizationEmbeddingAccounting" ("organizationId", "reservedPreparedBytes", "updatedAt") VALUES ('semantic-schema-org', 12, now());
SELECT pg_temp.semantic_reject('DELETE FROM organization WHERE id = ''semantic-schema-org''', 'organization_rag_cleanup_required', 'cached outstanding capacity blocks deletion');
SELECT pg_temp.semantic_reject('UPDATE "OrganizationEmbeddingAccounting" SET "observedBilledInputTokens" = ''NaN''::double precision WHERE "organizationId" = ''semantic-schema-org''', 'OrganizationEmbeddingAccounting_bounds_check', 'aggregate NaN rejected');
SELECT pg_temp.semantic_reject('UPDATE "OrganizationEmbeddingAccounting" SET "observedBilledInputTokens" = ''Infinity''::double precision WHERE "organizationId" = ''semantic-schema-org''', 'OrganizationEmbeddingAccounting_bounds_check', 'aggregate infinity rejected');
UPDATE "OrganizationEmbeddingAccounting" SET "reservedPreparedBytes" = 0, "observedBilledInputTokens" = 0.5, "observedSuccessfulRequests" = 1 WHERE "organizationId" = 'semantic-schema-org';
SELECT pg_temp.semantic_reject('DELETE FROM "OrganizationEmbeddingAccounting" WHERE "organizationId" = ''semantic-schema-org''', 'semantic_history_parent_required', 'organization tracking history cannot reset');
DELETE FROM organization WHERE id = 'semantic-schema-org';
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
    IF EXISTS (SELECT FROM "SemanticChunkPlan" WHERE "organizationId" = 'semantic-schema-org')
       OR EXISTS (SELECT FROM "EmbeddingWorkAttempt" WHERE "organizationId" = 'semantic-schema-org')
       OR EXISTS (SELECT FROM "OrganizationEmbeddingAccounting" WHERE "organizationId" = 'semantic-schema-org')
       OR EXISTS (SELECT FROM member WHERE id = 'semantic-schema-member') THEN
        RAISE EXCEPTION 'Cleaned settled history prevented native organization cascade';
    END IF;
    INSERT INTO semantic_schema_proofs VALUES ('clean organization cascades settled history');
    RAISE NOTICE 'Semantic schema constraint proofs: %', (SELECT count(*) FROM semantic_schema_proofs);
END $$;
ROLLBACK;
