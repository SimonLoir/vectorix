-- Every row/acknowledgment below is synthetic, transaction-local and rolled
-- back. This proves application constraints, never external cleanup/provider I/O.
BEGIN;
\ir parent-context-fixture.sql
CREATE TEMP TABLE parent_schema_proofs (name text PRIMARY KEY);
CREATE FUNCTION pg_temp.parent_reject(statement text, expected_constraint text, proof text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE actual_constraint text;
BEGIN
    BEGIN
        EXECUTE statement;
        SET CONSTRAINTS ALL IMMEDIATE;
    EXCEPTION WHEN integrity_constraint_violation THEN
        GET STACKED DIAGNOSTICS actual_constraint=CONSTRAINT_NAME;
        IF expected_constraint IS NOT NULL AND actual_constraint IS DISTINCT FROM expected_constraint THEN
            RAISE EXCEPTION 'Wrong parent constraint: expected %, got %',expected_constraint,actual_constraint;
        END IF;
        SET CONSTRAINTS ALL DEFERRED;
        INSERT INTO parent_schema_proofs VALUES(proof);
        RETURN;
    END;
    RAISE EXCEPTION 'Invalid parent mutation was accepted: %',proof;
END;
$$;
SELECT pg_temp.parent_fill('parent-schema-a');
SELECT pg_temp.parent_candidate('parent-schema-b',2);
SELECT pg_temp.parent_fill('parent-schema-b');
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT pg_temp.parent_reject($q$UPDATE "IndexGeneration" SET "parentContextVersion"=NULL WHERE id='00000000-0000-4000-8000-000000000091'$q$,'IndexGeneration_parent_immutable','descriptor cannot be removed');
SELECT pg_temp.parent_reject($q$UPDATE "IndexGeneration" SET "parentContextVersion"='future-version' WHERE id='00000000-0000-4000-8000-000000000091'$q$,'IndexGeneration_parent_immutable','descriptor cannot change');
SELECT pg_temp.parent_reject($q$UPDATE "CollectionConfigRevision" SET "parentChild"=false WHERE id='parent-schema-config'$q$,'CollectionConfigRevision_parent_immutable','saved profile flag cannot change');
SELECT pg_temp.parent_reject($q$INSERT INTO "IndexGeneration" SELECT (jsonb_populate_record(NULL::"IndexGeneration",to_jsonb(g)||'{"id":"00000000-0000-4000-8000-000000000092","requestId":"bad-descriptor","tableName":"g_00000000000040008000000000000092","parentContextVersion":null}')).* FROM "IndexGeneration" g WHERE id='00000000-0000-4000-8000-000000000091'$q$,'IndexGeneration_parent_descriptor','enabled profile requires descriptor');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('invalid-parent-link','parent-schema-a',3,'PARENT',0,12,'parent-schema-a-parent')$q$,'Chunk_parent_shape','parents cannot have a parent');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('invalid-child-null','parent-schema-a',3,'CHILD',0,6,NULL)$q$,'Chunk_parent_shape','children require parent identity');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('invalid-child-self','parent-schema-a',3,'CHILD',0,6,'invalid-child-self')$q$,'Chunk_parent_containment','self link cannot form a cycle');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('invalid-child-kind','parent-schema-a',3,'CHILD',0,6,'parent-schema-a-child-0')$q$,'Chunk_parent_containment','child cannot reference a child');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('invalid-child-owner','parent-schema-a',3,'CHILD',0,6,'parent-schema-b-parent')$q$,NULL,'parent belongs to exact candidate');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('invalid-child-range','parent-schema-a',3,'CHILD',0,13,'parent-schema-a-parent')$q$,'Chunk_parent_containment','child end stays inside parent');
SELECT pg_temp.parent_reject($q$INSERT INTO "Chunk" SELECT (jsonb_populate_record(NULL::"Chunk",to_jsonb(c)||'{"id":"invalid-parent-hash","ordinal":3,"embeddingInputHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}')).* FROM "Chunk" c WHERE id='parent-schema-a-parent'$q$,'Chunk_parent_shape','context-only parents have no embedding hash');
SELECT pg_temp.parent_reject($q$INSERT INTO "Chunk" SELECT (jsonb_populate_record(NULL::"Chunk",to_jsonb(c)||'{"id":"invalid-child-hash","ordinal":3,"embeddingInputHash":null}')).* FROM "Chunk" c WHERE id='parent-schema-a-child-0'$q$,'Chunk_parent_shape','children retain embedding hash');
SELECT pg_temp.parent_reject($q$INSERT INTO "Chunk" SELECT (jsonb_populate_record(NULL::"Chunk",to_jsonb(c)||'{"id":"invalid-null-bounds","ordinal":3,"startOffset":null,"endOffset":null}')).* FROM "Chunk" c WHERE id='parent-schema-a-parent'$q$,'Chunk_parent_geometry','parent bounds cannot be null');
SELECT pg_temp.parent_reject($q$INSERT INTO "Chunk" SELECT (jsonb_populate_record(NULL::"Chunk",to_jsonb(c)||'{"id":"invalid-one-bound","ordinal":3,"startOffset":null}')).* FROM "Chunk" c WHERE id='parent-schema-a-parent'$q$,'Chunk_parent_geometry','paired-offset null loophole rejected');
SELECT pg_temp.parent_reject($q$INSERT INTO "Chunk" SELECT (jsonb_populate_record(NULL::"Chunk",to_jsonb(c)||'{"id":"invalid-span","ordinal":3,"sourceSpans":[{"source":{"kind":"text","index":0,"start":0,"end":100},"start":0,"end":13}]}')).* FROM "Chunk" c WHERE id='parent-schema-a-parent'$q$,'Chunk_parent_geometry','source intersections stay inside canonical range');
SELECT pg_temp.parent_reject($q$INSERT INTO "Chunk" SELECT (jsonb_populate_record(NULL::"Chunk",to_jsonb(c)||'{"id":"invalid-json-index","ordinal":3,"sourceSpans":[{"source":{"kind":"text","index":0.5,"start":0,"end":100},"start":0,"end":12}]}')).* FROM "Chunk" c WHERE id='parent-schema-a-parent'$q$,'Chunk_parent_geometry','invalid JSON number rejects without cast leak');
SELECT pg_temp.parent_reject($q$UPDATE "Chunk" SET "endOffset"=5 WHERE id='parent-schema-a-parent'$q$,'Chunk_layout_immutable','parent shrink cannot invalidate children');
SELECT pg_temp.parent_reject($q$UPDATE "Chunk" SET kind='CHILD' WHERE id='parent-schema-a-parent'$q$,'Chunk_layout_immutable','parent type cannot change during staging');
SELECT pg_temp.parent_reject($q$UPDATE "Chunk" SET "lexicalSimple"=to_tsvector('simple','tampered') WHERE id='parent-schema-a-child-0'$q$,'Chunk_layout_immutable','direct derived FTS update cannot change staging content');
SELECT pg_temp.parent_reject($q$UPDATE "IndexedDocument" SET status='PUBLISHED',"manifestHash"=repeat('c',64),"vectorSealedAt"=now(),"publishedAt"=now() WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_transition','parent publication cannot skip application seal');
SELECT pg_temp.parent_reject($q$UPDATE "IndexedDocument" SET "chunkCount"=3,status='SEALED',"manifestHash"=repeat('c',64) WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_layout','seal verifies complete child accounting');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('unused-parent','parent-schema-a',3,'PARENT',0,12); UPDATE "IndexedDocument" SET status='SEALED',"manifestHash"=repeat('c',64) WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_layout','seal rejects unused parent rows');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_candidate('invalid-parent-ordinal',3); SELECT pg_temp.parent_fill('invalid-parent-ordinal','Alpha. Beta.',9); UPDATE "IndexedDocument" SET status='SEALED',"manifestHash"=repeat('c',64) WHERE id='invalid-parent-ordinal'$q$,'IndexedDocument_parent_layout','parent ordinal suffix must be contiguous');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_candidate('invalid-parent-bytes',3); SELECT pg_temp.parent_fill('invalid-parent-bytes',repeat('a',97)); UPDATE "IndexedDocument" SET status='SEALED',"manifestHash"=repeat('c',64) WHERE id='invalid-parent-bytes'$q$,'IndexedDocument_parent_layout','parent size uses actual UTF-8 budget');
DO $$ BEGIN
    IF EXISTS(SELECT FROM "Chunk" WHERE kind='PARENT' AND ("lexicalFrench"<>''::tsvector OR "lexicalEnglish"<>''::tsvector OR "lexicalSimple"<>''::tsvector))
        OR NOT EXISTS(SELECT FROM "Chunk" WHERE kind='CHILD' AND "lexicalSimple"<>''::tsvector) THEN RAISE EXCEPTION 'Parent FTS ownership is incorrect'; END IF;
    INSERT INTO parent_schema_proofs VALUES('only children own lexical payload');
END $$;
UPDATE "IndexedDocument" SET status='SEALED',"manifestHash"=repeat('c',64) WHERE id='parent-schema-a';
INSERT INTO parent_schema_proofs VALUES('complete layout seals without vector acknowledgment');
SELECT pg_temp.parent_reject($q$SELECT pg_temp.parent_chunk('late-child','parent-schema-a',3,'CHILD',0,6,'parent-schema-a-parent')$q$,'Chunk_layout_frozen','sealed candidate rejects insertion');
SELECT pg_temp.parent_reject($q$UPDATE "Chunk" SET text=text WHERE id='parent-schema-a-child-0'$q$,'Chunk_layout_frozen','sealed candidate rejects even no-op mutation statements');
SELECT pg_temp.parent_reject($q$DELETE FROM "Chunk" WHERE "indexedDocumentId"='parent-schema-a'$q$,'Chunk_layout_frozen','sealed candidate cannot lose layout rows');
SELECT pg_temp.parent_reject($q$UPDATE "IndexedDocument" SET status='STAGING' WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_transition','sealed candidate cannot reopen');
SELECT pg_temp.parent_reject($q$DELETE FROM "IndexedDocument" WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_cleanup','live owner cascade cannot bypass physical cleanup');
SELECT pg_temp.parent_reject($q$DELETE FROM "IndexGeneration" WHERE id='00000000-0000-4000-8000-000000000091'$q$,'IndexGeneration_parent_cleanup','live generation cascade cannot bypass cleanup');
-- Synthetic acknowledgment fields test the transition shape only; no external
-- publication or provider success is claimed by a SQL fixture.
UPDATE "IndexedDocument" SET status='PUBLISHED',"vectorSealedAt"=now(),"publishedAt"=now() WHERE id='parent-schema-a';
UPDATE "IndexedDocument" SET status='RETIRED',"retiredAt"=now() WHERE id='parent-schema-a';
SELECT pg_temp.parent_reject($q$UPDATE "IndexedDocument" SET status='STAGING' WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_transition','retired candidate cannot reopen through another state');
UPDATE "IndexGeneration" SET status='CLEANED' WHERE id='00000000-0000-4000-8000-000000000091';
SELECT pg_temp.parent_reject($q$DELETE FROM member WHERE id='parent-schema-member'; DELETE FROM organization WHERE id='parent-schema-org'$q$,'organization_rag_cleanup_required','actual chunks block native deletion despite stale cleaned generation');
DO $$ BEGIN IF NOT EXISTS(SELECT FROM member WHERE id='parent-schema-member') THEN RAISE EXCEPTION 'Members-first rejection did not roll back membership'; END IF; END $$;
UPDATE "IndexedDocument" SET status='RETIRED' WHERE id='parent-schema-b';
UPDATE "IndexedDocument" SET status='CLEANING' WHERE "organizationId"='parent-schema-org';
SELECT pg_temp.parent_reject($q$UPDATE "IndexedDocument" SET status='CLEANED',"materializedChunks"=0 WHERE id='parent-schema-a'$q$,'IndexedDocument_parent_cleanup','cleaned state requires zero actual rows');
DELETE FROM "Chunk" WHERE "organizationId"='parent-schema-org';
UPDATE "IndexedDocument" SET status='CLEANED',"materializedChunks"=0 WHERE "organizationId"='parent-schema-org';
DELETE FROM organization WHERE id='parent-schema-org';
SET CONSTRAINTS ALL IMMEDIATE;
DO $$ BEGIN
    IF EXISTS(SELECT FROM "Chunk" WHERE "organizationId"='parent-schema-org') OR EXISTS(SELECT FROM member WHERE id='parent-schema-member') THEN
        RAISE EXCEPTION 'Fully cleaned metadata cascade failed';
    END IF;
    INSERT INTO parent_schema_proofs VALUES('cleaning purge and cleaned native metadata cascade');
    RAISE NOTICE 'Parent schema constraint proofs: %',(SELECT count(*) FROM parent_schema_proofs);
END $$;
ROLLBACK;
