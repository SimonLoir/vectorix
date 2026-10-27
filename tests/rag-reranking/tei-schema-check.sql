-- Direct TEI expansion proofs run only in the catalog's migrated disposable
-- databases. No runtime/provider I/O occurs; every synthetic row is rolled back.
BEGIN;
DO $$ BEGIN
    IF current_database() NOT IN ('vectorix_catalog_test', 'vectorix_upgrade_test') THEN
        RAISE EXCEPTION 'TEI schema proofs require a runner-owned _test database';
    END IF;
END $$;
CREATE TEMP TABLE tei_schema_proofs (name text PRIMARY KEY);
CREATE FUNCTION pg_temp.tei_reject(statement text, expected_state text, expected_constraint text, proof text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE actual_state text; actual_constraint text;
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN integrity_constraint_violation THEN
        GET STACKED DIAGNOSTICS actual_state = RETURNED_SQLSTATE, actual_constraint = CONSTRAINT_NAME;
        IF actual_state IS DISTINCT FROM expected_state OR actual_constraint IS DISTINCT FROM expected_constraint THEN
            RAISE EXCEPTION 'TEI proof % rejected by unexpected constraint: % / %', proof, actual_state, actual_constraint;
        END IF;
        INSERT INTO tei_schema_proofs VALUES(proof);
        RETURN;
    END;
    RAISE EXCEPTION 'Invalid TEI mutation was accepted: %', proof;
END;
$$;
INSERT INTO organization (id,name,slug,"createdAt") VALUES
    ('tei-schema-org','Synthetic TEI schema','tei-schema-org',now()),
    ('tei-schema-other-org','Foreign synthetic TEI schema','tei-schema-other-org',now()),
    ('tei-schema-cascade-org','Synthetic TEI cascade','tei-schema-cascade-org',now());
INSERT INTO "Collection" (id,"organizationId",name,"updatedAt") VALUES
    ('tei-schema-collection','tei-schema-org','Synthetic TEI collection',now()),
    ('tei-schema-other-collection','tei-schema-other-org','Foreign TEI collection',now()),
    ('tei-schema-cascade-collection','tei-schema-cascade-org','Synthetic TEI cascade',now());
INSERT INTO "Credentials" (id,"organizationId",name,provider,"updatedAt")
VALUES ('tei-schema-hosted-credential','tei-schema-org','Preserved hosted binding','COHERE',now());
INSERT INTO "RerankEndpointCredential" (id,"organizationId",provider,name,endpoint,active,"updatedAt") VALUES
    ('tei-schema-endpoint','tei-schema-org','TEI','Native TEI','http://tei.example.test:8080',true,now()),
    ('tei-schema-foreign-endpoint','tei-schema-other-org','TEI','Foreign TEI','http://tei.example.test:8080',true,now()),
    ('tei-schema-cascade-endpoint','tei-schema-cascade-org','TEI','Cascade TEI','http://tei.example.test:8080',true,now());
INSERT INTO "CollectionRerankConfig" (id,"organizationId","collectionId",revision,enabled,provider,model,"candidatePool","capabilityVersion","selfHostedCredentialId","credentialRevision",endpoint,"runtimeSnapshot")
VALUES ('tei-schema-config','tei-schema-org','tei-schema-collection',1,true,'TEI','BAAI/bge-reranker-v2-m3',32,'native-tei-v1','tei-schema-endpoint',1,'http://tei.example.test:8080',
    '{"protocolVersion":"native-tei-v1","modelId":"BAAI/bge-reranker-v2-m3","modelRevision":"reported-revision","modelType":"reranker","maxInputLength":512,"maxClientBatchSize":32,"runtimeVersion":"1.8.3","modelDtype":"float32"}');
INSERT INTO tei_schema_proofs VALUES ('enabled organization TEI with optional key accepted'),('independent organizations may each select an active TEI endpoint');
CREATE FUNCTION pg_temp.tei_config(changes jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "CollectionRerankConfig"
    SELECT (jsonb_populate_record(NULL::"CollectionRerankConfig",to_jsonb(config)||'{"id":"tei-schema-invalid-config","revision":100}'||changes)).*
    FROM "CollectionRerankConfig" config WHERE id='tei-schema-config';
$$;
-- jsonb_populate_record maps a top-level JSON null field to SQL NULL. Direct
-- assignment is required to distinguish a real JSON-null snapshot in this test.
CREATE FUNCTION pg_temp.tei_raw_snapshot(snapshot jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "CollectionRerankConfig" (id,"organizationId","collectionId",revision,enabled,provider,model,"candidatePool","capabilityVersion","selfHostedCredentialId","credentialRevision",endpoint,"runtimeSnapshot")
    SELECT 'tei-schema-invalid-config',"organizationId","collectionId",100,enabled,provider,model,"candidatePool","capabilityVersion","selfHostedCredentialId","credentialRevision",endpoint,snapshot
    FROM "CollectionRerankConfig" WHERE id='tei-schema-config';
$$;
CREATE FUNCTION pg_temp.tei_endpoint(changes jsonb) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "RerankEndpointCredential"
    SELECT (jsonb_populate_record(NULL::"RerankEndpointCredential",to_jsonb(credential)||'{"id":"tei-schema-invalid-endpoint","name":"Another TEI","active":false}'||changes)).*
    FROM "RerankEndpointCredential" credential WHERE id='tei-schema-endpoint';
$$;

-- Hosted configurations and platform bindings retain their original shape.
INSERT INTO "CollectionRerankConfig" (id,"organizationId","collectionId",revision,enabled,provider,model,"credentialId","credentialRevision",endpoint) VALUES
    ('tei-schema-cohere','tei-schema-org','tei-schema-collection',2,true,'COHERE','rerank-v5.0-fast','tei-schema-hosted-credential',1,'https://api.cohere.test'),
    ('tei-schema-voyage','tei-schema-org','tei-schema-collection',3,true,'VOYAGE','rerank-3-lite',null,null,'https://api.voyage.test');
SELECT pg_temp.tei_config('{"id":"tei-schema-platform","revision":4,"selfHostedCredentialId":null,"credentialRevision":null}');
SELECT pg_temp.tei_config('{"id":"tei-schema-disabled","revision":5,"enabled":false,"selfHostedCredentialId":null,"credentialRevision":null,"endpoint":null,"runtimeSnapshot":null,"candidatePool":1}');
SELECT pg_temp.tei_config(jsonb_build_object('id','tei-schema-null-revision','revision',6,'runtimeSnapshot',"runtimeSnapshot"||'{"modelRevision":null}')) FROM "CollectionRerankConfig" WHERE id='tei-schema-config';
SELECT pg_temp.tei_config(jsonb_build_object('id','tei-schema-max-pool','revision',7,'candidatePool',100,'runtimeSnapshot',"runtimeSnapshot"||'{"maxClientBatchSize":100000,"maxInputLength":10000000}')) FROM "CollectionRerankConfig" WHERE id='tei-schema-config';
SELECT pg_temp.tei_config(jsonb_build_object('id','tei-schema-custom-model','revision',8,'model','/data/custom/model:v2@revision','runtimeSnapshot',"runtimeSnapshot"||'{"modelId":"/data/custom/model:v2@revision"}')) FROM "CollectionRerankConfig" WHERE id='tei-schema-config';
INSERT INTO tei_schema_proofs VALUES ('original hosted configurations accepted'),('TEI platform binding accepted'),('disabled unbound TEI needs no snapshot'),('reported revision may be explicitly unknown'),('pool and reported limits accept their upper bounds'),('bounded custom deployment identifiers accepted');

DO $$ DECLARE change jsonb; ordinal integer := 0; BEGIN
    FOREACH change IN ARRAY ARRAY[
        '{"provider":"S3"}', '{"capabilityVersion":"native-rerank-v1"}', '{"revision":0}',
        '{"model":""}', '{"model":"invalid model"}', '{"candidatePool":0}', '{"candidatePool":101}',
        '{"endpoint":null}', '{"endpoint":""}', '{"runtimeSnapshot":null}', '{"enabled":false}',
        '{"credentialId":"tei-schema-hosted-credential"}',
        '{"credentialId":"tei-schema-hosted-credential","selfHostedCredentialId":null}',
        '{"credentialRevision":null}', '{"credentialRevision":0}',
        '{"selfHostedCredentialId":null}',
        '{"provider":"COHERE","model":"rerank-v5.0-fast","capabilityVersion":"native-rerank-v1"}'
    ]::jsonb[] LOOP
        ordinal := ordinal+1;
        PERFORM pg_temp.tei_reject(format('SELECT pg_temp.tei_config(%L::jsonb)',change),'23514','rerank_config_valid','TEI configuration shape '||ordinal);
    END LOOP;
END $$;
DO $$ DECLARE snapshot jsonb; key text; shape jsonb; change jsonb; ordinal integer := 0; BEGIN
    SELECT "runtimeSnapshot" INTO STRICT snapshot FROM "CollectionRerankConfig" WHERE id='tei-schema-config';
    FOREACH key IN ARRAY ARRAY['protocolVersion','modelId','modelRevision','modelType','maxInputLength','maxClientBatchSize','runtimeVersion','modelDtype'] LOOP
        PERFORM pg_temp.tei_reject(format('SELECT pg_temp.tei_config(%L::jsonb)',jsonb_build_object('runtimeSnapshot',snapshot-key)),'23514','rerank_config_valid','missing snapshot key '||key);
    END LOOP;
    FOREACH shape IN ARRAY ARRAY['null','[]','[1]','"runtime"','123','true']::jsonb[] LOOP
        PERFORM pg_temp.tei_reject(format('SELECT pg_temp.tei_raw_snapshot(%L::jsonb)',shape),'23514','rerank_config_valid','wrong snapshot container '||shape::text);
    END LOOP;
    FOREACH change IN ARRAY ARRAY[
        '{"extra":true}', '{"protocolVersion":null}', '{"protocolVersion":"native-tei-v2"}',
        '{"modelId":null}', '{"modelId":123}', '{"modelId":"different/model"}',
        '{"modelRevision":""}', '{"modelRevision":123}', '{"modelRevision":{}}',
        '{"modelType":null}', '{"modelType":"embedding"}', '{"modelType":true}',
        '{"runtimeVersion":null}', '{"runtimeVersion":""}', '{"runtimeVersion":123}',
        '{"modelDtype":null}', '{"modelDtype":""}', '{"modelDtype":123}',
        '{"maxInputLength":null}', '{"maxInputLength":"512"}', '{"maxInputLength":0}',
        '{"maxInputLength":-1}', '{"maxInputLength":1.5}', '{"maxInputLength":10000001}',
        '{"maxClientBatchSize":null}', '{"maxClientBatchSize":"32"}', '{"maxClientBatchSize":0}',
        '{"maxClientBatchSize":31}', '{"maxClientBatchSize":1.5}', '{"maxClientBatchSize":100001}'
    ]::jsonb[] LOOP
        ordinal := ordinal+1;
        PERFORM pg_temp.tei_reject(format('SELECT pg_temp.tei_config(%L::jsonb)',jsonb_build_object('runtimeSnapshot',snapshot||change)),'23514','rerank_config_valid','malformed snapshot field '||ordinal);
    END LOOP;
    FOREACH key IN ARRAY ARRAY['modelRevision','runtimeVersion','modelDtype'] LOOP
        change := jsonb_build_object(key,repeat('x',CASE WHEN key='modelRevision' THEN 129 ELSE 65 END));
        PERFORM pg_temp.tei_reject(format('SELECT pg_temp.tei_config(%L::jsonb)',jsonb_build_object('runtimeSnapshot',snapshot||change)),'23514','rerank_config_valid','snapshot string bounded '||key);
    END LOOP;
END $$;
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config(jsonb_build_object('model',repeat('m',201)))$q$,'23514','rerank_config_valid','model identifier bounded');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config(jsonb_build_object('endpoint',repeat('x',2049)))$q$,'23514','rerank_config_valid','saved endpoint bounded');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config('{"provider":"COHERE","model":"rerank-v5.0-fast","capabilityVersion":"native-rerank-v1","selfHostedCredentialId":null,"credentialRevision":null}')$q$,'23514','rerank_config_valid','hosted snapshot forbidden');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config('{"provider":"COHERE","model":"rerank-v5.0-fast","capabilityVersion":"native-rerank-v1","runtimeSnapshot":null}')$q$,'23514','rerank_config_valid','hosted self-hosted reference forbidden');
SELECT pg_temp.tei_reject($q$UPDATE "CollectionRerankConfig" SET model=model WHERE id='tei-schema-config'$q$,'23514','rerank_config_immutable','TEI no-op revision update forbidden');
SELECT pg_temp.tei_reject($q$UPDATE "CollectionRerankConfig" SET "runtimeSnapshot"='{}' WHERE id='tei-schema-config'$q$,'23514','rerank_config_immutable','TEI runtime snapshot immutable');

DO $$ DECLARE change jsonb; ordinal integer := 0; BEGIN
    FOREACH change IN ARRAY ARRAY[
        '{"provider":"COHERE"}', '{"revision":0}', '{"name":""}', '{"name":" Leading"}', '{"name":"Trailing "}',
        '{"endpoint":""}', '{"endpoint":"ftp://tei.example.test"}', '{"endpoint":"https://user@tei.example.test"}',
        '{"endpoint":"https://tei.example.test/path"}', '{"endpoint":"https://tei.example.test?query=1"}',
        '{"endpoint":"https://tei.example.test#fragment"}', '{"apiKey":""}'
    ]::jsonb[] LOOP
        ordinal := ordinal+1;
        PERFORM pg_temp.tei_reject(format('SELECT pg_temp.tei_endpoint(%L::jsonb)',change),'23514','rerank_endpoint_valid','endpoint shape '||ordinal);
    END LOOP;
END $$;
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint(jsonb_build_object('name',repeat('n',101)))$q$,'23514','rerank_endpoint_valid','endpoint name bounded');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint(jsonb_build_object('endpoint','https://'||repeat('x',2048)))$q$,'23514','rerank_endpoint_valid','endpoint URL bounded');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint(jsonb_build_object('endpoint','https://tei.example.test'||chr(10)))$q$,'23514','rerank_endpoint_valid','endpoint control bytes refused');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint(jsonb_build_object('apiKey',repeat('x',131073)))$q$,'23514','rerank_endpoint_valid','encrypted key bytes bounded');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint('{"active":true}')$q$,'23505','rerank_endpoint_one_active','one active endpoint per organization and provider');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint('{"name":"Native TEI"}')$q$,'23505','RerankEndpointCredential_organizationId_provider_name_key','endpoint names unique within organization and provider');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_endpoint('{"organizationId":"tei-schema-missing-org"}')$q$,'23503','RerankEndpointCredential_organizationId_fkey','endpoint organization ownership');
SELECT pg_temp.tei_endpoint('{"id":"tei-schema-inactive","apiKey":"synthetic-ciphertext"}');
SELECT pg_temp.tei_endpoint(jsonb_build_object('id','tei-schema-max-key','name','Maximum synthetic ciphertext','apiKey',repeat('x',131072)));
INSERT INTO tei_schema_proofs VALUES ('inactive keyed endpoint accepted'),('maximum encrypted key bytes accepted');

-- Force the deferred constraint while probing invalid direct IDs; ordinary
-- transactions still default to deferral for native organization cascades.
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_constraint WHERE conname='CollectionRerankConfig_organizationId_selfHostedCredential_fkey' AND condeferrable AND condeferred) THEN
        RAISE EXCEPTION 'TEI retained binding must default to a deferred constraint';
    END IF;
    INSERT INTO tei_schema_proofs VALUES ('retained binding is initially deferred');
END $$;
SET CONSTRAINTS "CollectionRerankConfig_organizationId_selfHostedCredential_fkey" IMMEDIATE;
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config('{"selfHostedCredentialId":"tei-schema-foreign-endpoint"}')$q$,'23503','CollectionRerankConfig_organizationId_selfHostedCredential_fkey','foreign organization endpoint cannot bind');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config('{"selfHostedCredentialId":"tei-schema-missing-endpoint"}')$q$,'23503','CollectionRerankConfig_organizationId_selfHostedCredential_fkey','missing endpoint cannot bind');
SELECT pg_temp.tei_reject($q$SELECT pg_temp.tei_config('{"organizationId":"tei-schema-other-org","selfHostedCredentialId":"tei-schema-foreign-endpoint"}')$q$,'23503','CollectionRerankConfig_organizationId_collectionId_fkey','foreign collection cannot bind');
SELECT pg_temp.tei_reject($q$DELETE FROM "RerankEndpointCredential" WHERE id='tei-schema-endpoint'$q$,'23503','CollectionRerankConfig_organizationId_selfHostedCredential_fkey','saved TEI binding prevents endpoint removal');
SET CONSTRAINTS "CollectionRerankConfig_organizationId_selfHostedCredential_fkey" DEFERRED;

INSERT INTO "RerankRequest" (id,"organizationId","collectionId","configurationId",provider,"generationId","principalId","requestId",state,"expiresAt","dispatchedAt","dispatchDay","candidateCount","preparedInputBytes")
VALUES ('tei-schema-request','tei-schema-org','tei-schema-collection','tei-schema-config','TEI','synthetic-generation','user:synthetic','00000000-0000-4000-8000-000000000081','DISPATCHED',now()+interval '120 seconds',now(),current_date,32,512);
INSERT INTO "RerankUsageDay" ("organizationId",day,provider,"dispatchedRequests","dispatchedPreparedBytes") VALUES ('tei-schema-org',current_date,'TEI',1,512);
INSERT INTO tei_schema_proofs VALUES ('TEI dispatch receipt and unknown usage accepted');
SELECT pg_temp.tei_reject($q$UPDATE "RerankRequest" SET "preparedInputBytes"=0 WHERE id='tei-schema-request'$q$,'23514','rerank_request_valid','TEI dispatch retains existing positive-byte guard');
SELECT pg_temp.tei_reject($q$UPDATE "RerankRequest" SET provider='OPENAI' WHERE id='tei-schema-request'$q$,'23514','rerank_request_valid','request engines remain closed internally');
SELECT pg_temp.tei_reject($q$UPDATE "RerankUsageDay" SET "dispatchedRequests"=-1 WHERE "organizationId"='tei-schema-org'$q$,'23514','rerank_usage_valid','TEI daily counters remain nonnegative');
SELECT pg_temp.tei_reject($q$UPDATE "RerankUsageDay" SET provider='OPENAI' WHERE "organizationId"='tei-schema-org'$q$,'23514','rerank_usage_valid','daily engines remain closed internally');
DELETE FROM "Collection" WHERE id='tei-schema-collection';
DO $$ BEGIN
    IF EXISTS (SELECT FROM "CollectionRerankConfig" WHERE "organizationId"='tei-schema-org')
       OR (SELECT count(*) FROM "RerankRequest" WHERE id='tei-schema-request')<>1
       OR (SELECT "dispatchedRequests" FROM "RerankUsageDay" WHERE "organizationId"='tei-schema-org' AND provider='TEI') IS DISTINCT FROM 1::bigint
       OR NOT EXISTS (SELECT FROM "RerankEndpointCredential" WHERE id='tei-schema-endpoint') THEN
        RAISE EXCEPTION 'Collection cleanup lost retained TEI accounting or independent endpoint';
    END IF;
    INSERT INTO tei_schema_proofs VALUES ('collection cleanup preserves late TEI receipt, daily usage and independent endpoint');
END $$;

-- Delete a genuinely referenced endpoint/configuration pair through the native
-- organization cascade. No FK is dropped or disabled and no live work exists.
INSERT INTO "CollectionRerankConfig" (id,"organizationId","collectionId",revision,enabled,provider,model,"candidatePool","capabilityVersion","selfHostedCredentialId","credentialRevision",endpoint,"runtimeSnapshot")
VALUES ('tei-schema-cascade-config','tei-schema-cascade-org','tei-schema-cascade-collection',1,false,'TEI','custom/model',1,'native-tei-v1','tei-schema-cascade-endpoint',1,'http://tei.example.test:8080',null);
DELETE FROM organization WHERE id='tei-schema-cascade-org';
SET CONSTRAINTS "CollectionRerankConfig_organizationId_selfHostedCredential_fkey" IMMEDIATE;
DO $$ BEGIN
    IF EXISTS (SELECT FROM "CollectionRerankConfig" WHERE "organizationId"='tei-schema-cascade-org')
       OR EXISTS (SELECT FROM "RerankEndpointCredential" WHERE "organizationId"='tei-schema-cascade-org')
       OR EXISTS (SELECT FROM "Collection" WHERE "organizationId"='tei-schema-cascade-org') THEN
        RAISE EXCEPTION 'Native organization cascade retained TEI descendants';
    END IF;
    INSERT INTO tei_schema_proofs VALUES ('native organization deletion cascades deferred TEI bindings');
    RAISE NOTICE 'TEI schema constraint proofs: %',(SELECT count(*) FROM tei_schema_proofs);
END $$;
ROLLBACK;
