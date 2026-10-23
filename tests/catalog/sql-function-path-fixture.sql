-- Synthetic database-only graph. No storage, embedding, vector publication or
-- external cleanup is represented; callers own the surrounding transaction.
\ir parent-context-fixture.sql
INSERT INTO public."Collection" (id,"organizationId",name,"updatedAt","deletedAt")
VALUES ('sql-path-semantic-collection','parent-schema-org','Synthetic function-path semantic collection',now(),now());
INSERT INTO public."CollectionConfigRevision" (id,"organizationId","collectionId",revision,"vectorConnectionId",provider,model,dimensions,endpoint,chunking,"chunkingStrategy")
VALUES ('sql-path-semantic-config','parent-schema-org','sql-path-semantic-collection',1,'parent-schema-vector','OLLAMA','synthetic-function-path-model',2,'http://embedding.example.test','{}','SEMANTIC');
INSERT INTO public."IndexGeneration" (id,"organizationId","collectionId","requestId","configurationRevision","vectorConnectionId","vectorSchema","tableName","destinationFingerprint","modelIdentity","capabilitySnapshot","chunkerVersion",status,"createdBy","updatedAt")
VALUES ('00000000-0000-4000-8000-000000000095','parent-schema-org','sql-path-semantic-collection','sql-path-semantic-request',1,'parent-schema-vector','vector_collections','g_00000000000040008000000000000095','synthetic-parent-vector',repeat('d',64),'{"dimensions":2}','semantic-utf8-v1','BUILDING','parent-schema-user',now());
INSERT INTO public."IndexedDocument" (id,"organizationId","collectionId","generationId","documentId","sourceVersionId","extractionId","extractorVersion","buildRevision","metadataRevision","sourceChangeSequence","fileName","mediaType",language,"documentCreatedAt","sourceCreatedAt","updatedAt")
SELECT 'sql-path-semantic-'||suffix,'parent-schema-org','sql-path-semantic-collection','00000000-0000-4000-8000-000000000095','parent-schema-document','parent-schema-version','parent-schema-extraction','utf8-text-v1',revision,1,0,'Synthetic function-path.txt','text/plain','FR',now(),now(),now()
FROM (VALUES ('candidate',1),('invalid',2)) ids(suffix,revision);
