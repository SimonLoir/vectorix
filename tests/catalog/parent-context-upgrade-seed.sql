-- M6b-era rows, before parent columns exist. Preserve their exact saved JSON,
-- hashes and checkpoint bytes; no parent or canonical range is guessed.
INSERT INTO "Chunk" (id,"organizationId","generationId","indexedDocumentId",ordinal,text,"textHash","embeddingInputHash","sourceSpans",language,"tokenCount")
VALUES ('upgrade-parent-historical-child','upgrade-org','00000000-0000-4000-8000-000000000041','upgrade-semantic-historical-candidate',0,'Existing source',repeat('a',64),repeat('b',64),'[{"source":{"kind":"text","index":0,"start":0,"end":15},"start":0,"end":15}]','FR',5);
UPDATE "IndexedDocument" SET "chunkCount"=1,"materializedChunks"=1 WHERE id='upgrade-semantic-historical-candidate';
INSERT INTO "Collection" (id,"organizationId",name,"updatedAt") VALUES ('upgrade-parent-semantic-collection','upgrade-org','Existing unfinished semantic work',now());
INSERT INTO "CollectionConfigRevision" (id,"organizationId","collectionId",revision,"vectorConnectionId",provider,model,dimensions,endpoint,chunking,"chunkingStrategy")
VALUES ('upgrade-parent-semantic-config','upgrade-org','upgrade-parent-semantic-collection',1,'upgrade-rebuild-vector','OLLAMA','existing-semantic-model',2,'http://embedding.example.test','{}','SEMANTIC');
INSERT INTO "IndexGeneration" (id,"organizationId","collectionId","requestId","configurationRevision","vectorConnectionId","vectorSchema","tableName","destinationFingerprint","modelIdentity","capabilitySnapshot","chunkerVersion",status,"createdBy","updatedAt")
VALUES ('00000000-0000-4000-8000-000000000093','upgrade-org','upgrade-parent-semantic-collection','upgrade-parent-semantic-request',1,'upgrade-rebuild-vector','vector_collections','g_00000000000040008000000000000093','upgrade-rebuild-destination',repeat('d',64),'{"dimensions":2}','semantic-utf8-v1','BUILDING','upgrade-user',now());
INSERT INTO "IndexedDocument" (id,"organizationId","collectionId","generationId","documentId","sourceVersionId","extractionId","extractorVersion","buildRevision","metadataRevision","sourceChangeSequence","fileName","mediaType",language,"documentCreatedAt","sourceCreatedAt","updatedAt")
VALUES ('upgrade-parent-semantic-candidate','upgrade-org','upgrade-parent-semantic-collection','00000000-0000-4000-8000-000000000093','upgrade-document','upgrade-version','upgrade-extraction','utf8-text-v1',1,1,0,'Existing unfinished.txt','text/plain','FR',now(),now(),now());
INSERT INTO "SemanticChunkPlan" ("indexedDocumentId","organizationId","generationId","configurationRevision","chunkerVersion","unitizerVersion","sourceHash","profileHash","modelIdentity","unitManifestHash","unitCount","unitRanges","completedUnits","lastUnitVector","storedBytes","reservedBytes","updatedAt")
VALUES ('upgrade-parent-semantic-candidate','upgrade-org','00000000-0000-4000-8000-000000000093',1,'semantic-utf8-v1','semantic-units-utf8-v1',repeat('a',64),repeat('b',64),repeat('d',64),repeat('e',64),2,'[{"ordinal":0,"start":0,"end":6},{"ordinal":1,"start":7,"end":12}]',1,decode('0000803f00000000','hex'),1000,100,now());
INSERT INTO "OrganizationEmbeddingAccounting" ("organizationId","storedPlanBytes","reservedPlanBytes","updatedAt") VALUES ('upgrade-org',1000,100,now());
INSERT INTO "RagAuditLog" (id,"organizationId","actorType","actorId",action,details)
SELECT 'upgrade-parent-snapshot','upgrade-org','test','disposable-fixture','test.parentMigrationSnapshot',
    jsonb_build_object('plan',to_jsonb(plan),'child',(SELECT to_jsonb(child) FROM "Chunk" child WHERE id='upgrade-parent-historical-child'))
FROM "SemanticChunkPlan" plan WHERE "indexedDocumentId"='upgrade-parent-semantic-candidate';
