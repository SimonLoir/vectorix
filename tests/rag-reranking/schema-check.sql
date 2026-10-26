-- Direct constraint probes run only in the catalog runner's migrated disposable
-- database. Every synthetic row and helper is rolled back; no provider I/O occurs.
BEGIN;
DO $$ BEGIN
    IF current_database() NOT IN ('vectorix_catalog_test', 'vectorix_upgrade_test') THEN
        RAISE EXCEPTION 'Reranking schema proofs require a runner-owned _test database';
    END IF;
END $$;
CREATE TEMP TABLE rerank_schema_proofs (name text PRIMARY KEY);
CREATE FUNCTION pg_temp.rerank_reject(statement text, expected_state text, expected_constraint text, proof text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual_state text; actual_constraint text;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN integrity_constraint_violation THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE, actual_constraint = CONSTRAINT_NAME;
        IF actual_state IS DISTINCT FROM expected_state OR actual_constraint IS DISTINCT FROM expected_constraint THEN
            RAISE EXCEPTION 'Reranking proof % rejected by unexpected constraint: % / %', proof, actual_state, actual_constraint;
        END IF;
        INSERT INTO rerank_schema_proofs VALUES(proof);
        RETURN;
    END;
    RAISE EXCEPTION 'Invalid reranking mutation was accepted: %', proof;
END;
$$;
INSERT INTO organization (id, name, slug, "createdAt") VALUES
    ('rerank-schema-org', 'Synthetic reranking schema', 'rerank-schema-org', now()),
    ('rerank-schema-other-org', 'Foreign synthetic reranking schema', 'rerank-schema-other-org', now());
INSERT INTO "Collection" (id, "organizationId", name, "updatedAt") VALUES
    ('rerank-schema-collection', 'rerank-schema-org', 'Synthetic reranking collection', now()),
    ('rerank-schema-other-collection', 'rerank-schema-other-org', 'Foreign synthetic reranking collection', now());
INSERT INTO "Credentials" (id, "organizationId", name, provider, "updatedAt") VALUES
    ('rerank-schema-credential', 'rerank-schema-org', 'Synthetic Cohere binding', 'COHERE', now()),
    ('rerank-schema-voyage-credential', 'rerank-schema-org', 'Synthetic Voyage binding', 'VOYAGE', now()),
    ('rerank-schema-foreign-credential', 'rerank-schema-other-org', 'Foreign Cohere binding', 'COHERE', now());
INSERT INTO "CollectionRerankConfig" (id, "organizationId", "collectionId", revision, enabled, provider, model, endpoint)
VALUES ('rerank-schema-config', 'rerank-schema-org', 'rerank-schema-collection', 1, true, 'COHERE', 'rerank-v5.0-fast', 'https://rerank.example.test');
CREATE FUNCTION pg_temp.rerank_config(changes jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "CollectionRerankConfig"
    SELECT (jsonb_populate_record(NULL::"CollectionRerankConfig", to_jsonb(config) || '{"id":"rerank-schema-invalid-config","revision":2}' || changes)).*
    FROM "CollectionRerankConfig" config WHERE id='rerank-schema-config';
$$;
DO $$ DECLARE change jsonb; ordinal integer := 0; BEGIN
    FOREACH change IN ARRAY ARRAY[
        '{"provider":"S3"}', '{"provider":"OLLAMA"}', '{"provider":"OPENAI"}', '{"provider":"MISTRAL"}',
        '{"model":"rerank-3"}', '{"model":"unreviewed"}', '{"revision":0}', '{"candidatePool":0}', '{"candidatePool":101}',
        '{"capabilityVersion":"native-rerank-v2"}', '{"endpoint":null}', '{"endpoint":""}',
        '{"credentialId":"rerank-schema-credential","credentialRevision":null}',
        '{"credentialId":null,"credentialRevision":1}', '{"credentialId":"rerank-schema-credential","credentialRevision":0}'
    ]::jsonb[] LOOP
        ordinal := ordinal+1;
        PERFORM pg_temp.rerank_reject(format('SELECT pg_temp.rerank_config(%L::jsonb)',change), '23514', 'rerank_config_valid', 'configuration shape '||ordinal);
    END LOOP;
END $$;
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_config(jsonb_build_object('endpoint',repeat('x',2049)))$q$, '23514', 'rerank_config_valid', 'endpoint bounded');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_config('{"organizationId":"rerank-schema-other-org"}')$q$, '23503', 'CollectionRerankConfig_organizationId_collectionId_fkey', 'cross-organization collection binding');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_config('{"credentialId":"rerank-schema-foreign-credential","credentialRevision":1}')$q$, '23503', 'CollectionRerankConfig_organizationId_credentialId_provide_fkey', 'cross-organization credential binding');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_config('{"credentialId":"rerank-schema-voyage-credential","credentialRevision":1}')$q$, '23503', 'CollectionRerankConfig_organizationId_credentialId_provide_fkey', 'wrong-provider credential binding');
SELECT pg_temp.rerank_reject($q$UPDATE "CollectionRerankConfig" SET model=model WHERE id='rerank-schema-config'$q$, '23514', 'rerank_config_immutable', 'even no-op revision update forbidden');
SELECT pg_temp.rerank_reject($q$UPDATE "CollectionRerankConfig" SET endpoint='https://retarget.example.test' WHERE id='rerank-schema-config'$q$, '23514', 'rerank_config_immutable', 'saved destination immutable');
SELECT pg_temp.rerank_config('{"enabled":false,"endpoint":null,"candidatePool":1}');
INSERT INTO rerank_schema_proofs VALUES ('disabled unbound revision and minimum pool accepted');
INSERT INTO "CollectionRerankConfig" (id, "organizationId", "collectionId", revision, provider, model, "candidatePool", "credentialId", "credentialRevision")
VALUES ('rerank-schema-bound-config','rerank-schema-org','rerank-schema-collection',3,'COHERE','rerank-v5.0-pro',100,'rerank-schema-credential',1);
INSERT INTO "CollectionRerankConfig" (id, "organizationId", "collectionId", revision, provider, model)
VALUES ('rerank-schema-voyage-config','rerank-schema-org','rerank-schema-collection',4,'VOYAGE','rerank-3-lite');
INSERT INTO rerank_schema_proofs VALUES ('reviewed alternative models and maximum pool accepted');

-- Captured collection/configuration/generation IDs intentionally need no live
-- content FK; organization ownership and application admission establish authority.
INSERT INTO "RerankRequest" (id,"organizationId","collectionId","configurationId",provider,"generationId","principalId","requestId",state,"expiresAt","dispatchedAt","dispatchDay","candidateCount","preparedInputBytes")
VALUES ('rerank-schema-request','rerank-schema-org','rerank-schema-collection','rerank-schema-config','COHERE','00000000-0000-4000-8000-000000000091','user:synthetic','00000000-0000-4000-8000-000000000092','DISPATCHED',now()+interval '120 seconds',now(),current_date,2,8);
CREATE FUNCTION pg_temp.rerank_request(changes jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "RerankRequest"
    SELECT (jsonb_populate_record(NULL::"RerankRequest", to_jsonb(request) || '{"id":"rerank-schema-invalid-request","requestId":"00000000-0000-4000-8000-000000000093"}' || changes)).*
    FROM "RerankRequest" request WHERE id='rerank-schema-request';
$$;
DO $$ DECLARE change jsonb; ordinal integer := 0; BEGIN
    FOREACH change IN ARRAY ARRAY[
        '{"provider":"S3"}', '{"principalId":""}', '{"requestId":"not-a-uuid"}',
        '{"candidateCount":0}', '{"candidateCount":101}', '{"preparedInputBytes":0}', '{"preparedInputBytes":512001}',
        '{"dispatchedAt":null}', '{"dispatchDay":null}', '{"providerInputTokens":-1}', '{"nativeDurationMicros":-1}',
        '{"billedInputTokens":-1}', '{"billedInputTokens":"NaN"}', '{"billedInputTokens":"Infinity"}', '{"billedInputTokens":"-Infinity"}',
        '{"billedSearchUnits":-1}', '{"billedSearchUnits":"NaN"}', '{"billedSearchUnits":"Infinity"}', '{"billedSearchUnits":"-Infinity"}',
        '{"state":"ADMITTED"}', '{"state":"SKIPPED"}', '{"state":"FAILED"}', '{"state":"UNCERTAIN"}',
        '{"state":"VALIDATED","completedAt":"2026-10-26T00:00:00Z","capacityReleasedAt":"2026-10-26T00:00:00Z"}',
        '{"errorCode":"raw provider response"}'
    ]::jsonb[] LOOP
        ordinal := ordinal+1;
        PERFORM pg_temp.rerank_reject(format('SELECT pg_temp.rerank_request(%L::jsonb)',change), '23514', 'rerank_request_valid', 'request shape '||ordinal);
    END LOOP;
END $$;
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_request(jsonb_build_object('principalId',repeat('p',513)))$q$, '23514', 'rerank_request_valid', 'principal bounded');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_request(jsonb_build_object('errorCode',repeat('A',65)))$q$, '23514', 'rerank_request_valid', 'error code bounded');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_request(jsonb_build_object('expiresAt',now()-interval '1 second'))$q$, '23514', 'rerank_request_valid', 'claim expiry follows admission');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_request('{"organizationId":"missing-schema-org"}')$q$, '23503', 'RerankRequest_organizationId_fkey', 'retained receipt organization ownership');
SELECT pg_temp.rerank_reject($q$SELECT pg_temp.rerank_request('{"requestId":"00000000-0000-4000-8000-000000000092"}')$q$, '23505', 'RerankRequest_organizationId_principalId_requestId_key', 'request replay unique within principal');
SELECT pg_temp.rerank_request('{"state":"VALIDATED","completedAt":"2026-10-26T00:00:00Z","capacityReleasedAt":"2026-10-26T00:00:00Z","nativeDurationMicros":0,"providerInputTokens":0,"billedInputTokens":0,"billedSearchUnits":0}');
INSERT INTO rerank_schema_proofs VALUES ('explicit zero validated usage and duration accepted');
INSERT INTO "RerankRequest" (id,"organizationId","collectionId","configurationId",provider,"generationId","principalId","requestId","expiresAt")
VALUES ('rerank-schema-admitted','rerank-schema-org','deleted-scalar-collection','deleted-scalar-config','VOYAGE','deleted-scalar-generation',repeat('p',512),'00000000-0000-4000-8000-000000000092',now()+interval '120 seconds');
UPDATE "RerankRequest" SET state='FAILED',"completedAt"=now(),"capacityReleasedAt"=now(),"errorCode"='INPUT_TOO_LARGE' WHERE id='rerank-schema-admitted';
INSERT INTO rerank_schema_proofs VALUES ('maximum principal, isolated request key and pre-dispatch failure accepted');

INSERT INTO "RerankUsageDay" ("organizationId",day,provider,"dispatchedRequests","dispatchedPreparedBytes") VALUES ('rerank-schema-org',current_date,'COHERE',1,8);
DO $$ DECLARE field text; value text; BEGIN
    FOREACH field IN ARRAY ARRAY['dispatchedRequests','dispatchedPreparedBytes','validatedRequests','validatedDocuments','knownProviderInputTokens','unknownProviderInputTokenRequests','unknownBilledInputTokenRequests','unknownBilledSearchUnitRequests','observedNativeDurationMicros'] LOOP
        PERFORM pg_temp.rerank_reject(format('UPDATE "RerankUsageDay" SET %I=-1 WHERE "organizationId"=%L',field,'rerank-schema-org'),'23514','rerank_usage_valid','negative daily '||field);
    END LOOP;
    FOREACH field IN ARRAY ARRAY['knownBilledInputTokens','knownBilledSearchUnits'] LOOP
        FOREACH value IN ARRAY ARRAY['-1','NaN','Infinity','-Infinity'] LOOP
            PERFORM pg_temp.rerank_reject(format('UPDATE "RerankUsageDay" SET %I=%L::float8 WHERE "organizationId"=%L',field,value,'rerank-schema-org'),'23514','rerank_usage_valid','nonfinite or negative daily '||field||' '||value);
        END LOOP;
    END LOOP;
END $$;
SELECT pg_temp.rerank_reject($q$UPDATE "RerankUsageDay" SET provider='OPENAI' WHERE "organizationId"='rerank-schema-org'$q$,'23514','rerank_usage_valid','closed daily provider');
INSERT INTO "OrganizationRerankAccounting" ("organizationId") VALUES ('rerank-schema-org');
SELECT pg_temp.rerank_reject($q$UPDATE "OrganizationRerankAccounting" SET "lockRevision"=-1 WHERE "organizationId"='rerank-schema-org'$q$,'23514','rerank_lock_valid','nonnegative organization lock');
DELETE FROM "Collection" WHERE id='rerank-schema-collection';
DO $$ BEGIN
    IF (SELECT count(*) FROM "CollectionRerankConfig" WHERE "organizationId"='rerank-schema-org')<>0
        OR (SELECT count(*) FROM "RerankRequest" WHERE "organizationId"='rerank-schema-org')<>3
        OR (SELECT "dispatchedRequests" FROM "RerankUsageDay" WHERE "organizationId"='rerank-schema-org' AND provider='COHERE')<>1
    THEN RAISE EXCEPTION 'Collection deletion lost retained request or daily accounting'; END IF;
    INSERT INTO rerank_schema_proofs VALUES ('physical collection deletion preserves in-flight and settled request receipts and daily debit');
    RAISE NOTICE 'Reranking schema constraint proofs: %',(SELECT count(*) FROM rerank_schema_proofs);
END $$;
ROLLBACK;
