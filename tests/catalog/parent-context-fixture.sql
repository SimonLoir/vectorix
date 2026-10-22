-- Synthetic application rows only. No object/vector/provider operation is
-- represented by this fixture; callers own a disposable _test database.
DO $$ BEGIN
    IF current_database() NOT LIKE '%\_test' ESCAPE '\' THEN RAISE EXCEPTION 'Parent probes require a disposable _test database'; END IF;
END $$;
INSERT INTO "user" (id,name,email) VALUES ('parent-schema-user','Synthetic parent owner','parent-schema@example.test');
INSERT INTO organization (id,name,slug,"createdAt") VALUES ('parent-schema-org','Synthetic parent organization','parent-schema-org',now());
INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ('parent-schema-member','parent-schema-org','parent-schema-user','owner',now());
INSERT INTO "StorageLocation" (id,"organizationId",fingerprint,endpoint,bucket,region,"forcePathStyle")
VALUES ('parent-schema-storage','parent-schema-org','parent-schema-storage','https://storage.example.test','synthetic-parent','us-east-1',true);
INSERT INTO "Document" (id,"organizationId",name,status,"updatedAt","deletedAt")
VALUES ('parent-schema-document','parent-schema-org','Synthetic purged.txt','DELETED',now(),now());
INSERT INTO "DocumentVersion" (id,"organizationId","documentId",version,"storageLocationId","objectKey",sha256,"byteSize","mediaType",status,"discardedAt","contentState")
VALUES ('parent-schema-version','parent-schema-org','parent-schema-document',1,'parent-schema-storage','synthetic-purged-original',repeat('a',64),12,'text/plain','DELETED',now(),'PURGED');
INSERT INTO "DocumentExtraction" (id,"organizationId","versionId","storageLocationId","objectKey","byteSize","extractorVersion",language,"discardedAt")
VALUES ('parent-schema-extraction','parent-schema-org','parent-schema-version','parent-schema-storage','synthetic-purged-text',12,'utf8-text-v1','fr',now());
INSERT INTO "VectorConnection" (id,"organizationId","destinationFingerprint") VALUES ('parent-schema-vector','parent-schema-org','synthetic-parent-vector');
INSERT INTO "Collection" (id,"organizationId",name,"updatedAt","deletedAt") VALUES ('parent-schema-collection','parent-schema-org','Synthetic parent collection',now(),now());
INSERT INTO "CollectionConfigRevision" (id,"organizationId","collectionId",revision,"vectorConnectionId",provider,model,dimensions,endpoint,chunking,"parentChild")
VALUES ('parent-schema-config','parent-schema-org','parent-schema-collection',1,'parent-schema-vector','OLLAMA','synthetic-parent-model',2,'http://embedding.example.test','{"targetTokens":32,"minTokens":1,"maxTokens":32,"overlapTokens":0,"semanticPercentile":90,"parentMaxTokens":32}',true);
INSERT INTO "IndexGeneration" (id,"organizationId","collectionId","requestId","configurationRevision","vectorConnectionId","vectorSchema","tableName","destinationFingerprint","modelIdentity","capabilitySnapshot","chunkerVersion","parentContextVersion",status,"createdBy","updatedAt")
VALUES ('00000000-0000-4000-8000-000000000091','parent-schema-org','parent-schema-collection','synthetic-parent-request',1,'parent-schema-vector','vector_collections','g_00000000000040008000000000000091','synthetic-parent-vector',repeat('d',64),'{"dimensions":2}','structure-utf8-v1','parent-context-utf8-v1','BUILDING','parent-schema-user',now());
INSERT INTO "IndexedDocument" (id,"organizationId","collectionId","generationId","documentId","sourceVersionId","extractionId","extractorVersion","buildRevision","metadataRevision","sourceChangeSequence","fileName","mediaType",language,"documentCreatedAt","sourceCreatedAt","chunkCount","materializedChunks","updatedAt")
VALUES ('parent-schema-a','parent-schema-org','parent-schema-collection','00000000-0000-4000-8000-000000000091','parent-schema-document','parent-schema-version','parent-schema-extraction','utf8-text-v1',1,1,0,'Synthetic parent.txt','text/plain','FR',now(),now(),2,2,now());
CREATE FUNCTION pg_temp.parent_candidate(candidate_id text, build_revision integer, child_count integer DEFAULT 2) RETURNS void LANGUAGE sql AS $$
    INSERT INTO "IndexedDocument" SELECT (jsonb_populate_record(NULL::"IndexedDocument",to_jsonb(candidate)||jsonb_build_object('id',candidate_id,'buildRevision',build_revision,'chunkCount',child_count,'materializedChunks',child_count,'status','STAGING','manifestHash',NULL,'vectorSealedAt',NULL,'publishedAt',NULL,'retiredAt',NULL))).*
    FROM "IndexedDocument" candidate WHERE id='parent-schema-a';
$$;
CREATE FUNCTION pg_temp.parent_chunk(chunk_id text, owner_id text, chunk_ordinal integer, row_kind "RagChunkKind", first_offset integer, last_offset integer, parent_id text DEFAULT NULL, content text DEFAULT 'Synthetic') RETURNS void LANGUAGE sql AS $$
    INSERT INTO "Chunk" (id,"organizationId","generationId","indexedDocumentId",ordinal,kind,text,"textHash","embeddingInputHash","sourceSpans","startOffset","endOffset",language,"tokenCount","parentId")
    VALUES (chunk_id,'parent-schema-org','00000000-0000-4000-8000-000000000091',owner_id,chunk_ordinal,row_kind,content,repeat('a',64),CASE WHEN row_kind='CHILD' THEN repeat('b',64) END,
        jsonb_build_array(jsonb_build_object('source',jsonb_build_object('kind','text','index',0,'start',0,'end',100),'start',first_offset,'end',last_offset)),first_offset,last_offset,'FR',1,parent_id);
$$;
CREATE FUNCTION pg_temp.parent_fill(owner_id text, parent_text text DEFAULT 'Alpha. Beta.', parent_position integer DEFAULT 2) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_temp.parent_chunk(owner_id||'-parent',owner_id,parent_position,'PARENT',0,12,NULL,parent_text);
    PERFORM pg_temp.parent_chunk(owner_id||'-child-0',owner_id,0,'CHILD',0,6,owner_id||'-parent','Alpha.');
    PERFORM pg_temp.parent_chunk(owner_id||'-child-1',owner_id,1,'CHILD',7,12,owner_id||'-parent','Beta.');
END;
$$;
