-- AlterTable
ALTER TABLE "Chunk" ADD COLUMN     "endOffset" INTEGER,
ADD COLUMN     "startOffset" INTEGER,
ALTER COLUMN "embeddingInputHash" DROP NOT NULL;

-- AlterTable
ALTER TABLE "IndexGeneration" ADD COLUMN     "parentContextVersion" VARCHAR(100);

-- Prisma cannot express same-candidate layout validation, immutable application
-- seals, transition-table owner touches, or native-delete cleanup backstops.
-- Child-only historical rows keep null descriptors/bounds and their old lifecycle.
ALTER TABLE "IndexGeneration" ADD CONSTRAINT "IndexGeneration_parent_version_check" CHECK (
    "parentContextVersion" IS NULL OR "parentContextVersion" ~ '^[a-z][a-z0-9-]{0,99}$'
);
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_parent_offsets_check" CHECK (
    ("startOffset" IS NULL AND "endOffset" IS NULL)
    OR ("startOffset" IS NOT NULL AND "endOffset" IS NOT NULL
        AND "startOffset" >= 0 AND "startOffset" < "endOffset" AND "endOffset" <= 26214400)
);
ALTER TABLE "Chunk" ADD CONSTRAINT "Chunk_child_embedding_hash_check" CHECK (
    kind <> 'CHILD' OR "embeddingInputHash" IS NOT NULL
);

CREATE FUNCTION vectorix_parent_generation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_mode boolean;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW."parentContextVersion" IS DISTINCT FROM OLD."parentContextVersion"
            OR (OLD."parentContextVersion" IS NOT NULL AND
                (NEW.id, NEW."organizationId", NEW."collectionId", NEW."configurationRevision",
                 NEW."vectorConnectionId", NEW."vectorSchema", NEW."tableName", NEW."destinationFingerprint",
                 NEW."modelIdentity", NEW."capabilitySnapshot", NEW."chunkerVersion", NEW."requestId",
                 NEW."previousGenerationId", NEW."createdAt", NEW."createdBy") IS DISTINCT FROM
                (OLD.id, OLD."organizationId", OLD."collectionId", OLD."configurationRevision",
                 OLD."vectorConnectionId", OLD."vectorSchema", OLD."tableName", OLD."destinationFingerprint",
                 OLD."modelIdentity", OLD."capabilitySnapshot", OLD."chunkerVersion", OLD."requestId",
                 OLD."previousGenerationId", OLD."createdAt", OLD."createdBy")) THEN
            RAISE EXCEPTION 'Parent execution identity is immutable' USING ERRCODE='23514', CONSTRAINT='IndexGeneration_parent_immutable';
        END IF;
        RETURN NEW;
    END IF;
    SELECT "parentChild" INTO parent_mode FROM "CollectionConfigRevision"
    WHERE "organizationId"=NEW."organizationId" AND "collectionId"=NEW."collectionId"
        AND revision=NEW."configurationRevision" FOR SHARE;
    IF NOT FOUND OR parent_mode IS DISTINCT FROM (NEW."parentContextVersion" IS NOT NULL) THEN
        RAISE EXCEPTION 'Invalid parent execution descriptor' USING ERRCODE='23514', CONSTRAINT='IndexGeneration_parent_descriptor';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_parent_generation_identity BEFORE INSERT OR UPDATE ON "IndexGeneration"
FOR EACH ROW EXECUTE FUNCTION vectorix_parent_generation_identity();

CREATE FUNCTION vectorix_parent_revision_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW."parentChild" IS DISTINCT FROM OLD."parentChild" AND EXISTS (
        SELECT 1 FROM "IndexGeneration" WHERE "organizationId"=OLD."organizationId"
            AND "collectionId"=OLD."collectionId" AND "configurationRevision"=OLD.revision
    ) THEN
        RAISE EXCEPTION 'Accepted parent profile is immutable' USING ERRCODE='23514', CONSTRAINT='CollectionConfigRevision_parent_immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_parent_revision_identity BEFORE UPDATE OF "parentChild" ON "CollectionConfigRevision"
FOR EACH ROW EXECUTE FUNCTION vectorix_parent_revision_identity();

-- Bounded canonical offsets in JSON must be integers before any cast. A source
-- intersection cannot establish canonical text equality; workers prove that
-- separately against the exact private extraction before application sealing.
CREATE FUNCTION vectorix_parent_offset_valid(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
    IF jsonb_typeof(value) IS DISTINCT FROM 'number' OR value::text !~ '^(0|[1-9][0-9]{0,7})$' THEN RETURN false; END IF;
    RETURN value::text::bigint <= 26214400;
END;
$$;
CREATE FUNCTION vectorix_parent_spans_valid(spans jsonb, first_offset integer, last_offset integer) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE span jsonb; source jsonb; first_span integer; last_span integer; source_first integer; source_last integer;
BEGIN
    IF first_offset IS NULL OR last_offset IS NULL OR jsonb_typeof(spans) IS DISTINCT FROM 'array'
        OR jsonb_array_length(spans) NOT BETWEEN 1 AND 5000 THEN RETURN false; END IF;
    FOR span IN SELECT value FROM jsonb_array_elements(spans) LOOP
        IF jsonb_typeof(span) IS DISTINCT FROM 'object'
            OR (SELECT count(*) FROM jsonb_object_keys(span)) <> 3
            OR NOT (span ?& ARRAY['source','start','end'])
            OR NOT vectorix_parent_offset_valid(span->'start')
            OR NOT vectorix_parent_offset_valid(span->'end') THEN RETURN false; END IF;
        source := span->'source';
        IF jsonb_typeof(source) IS DISTINCT FROM 'object'
            OR (source->>'kind' IN ('text','pdf-page','docx-paragraph')) IS NOT TRUE
            OR NOT vectorix_parent_offset_valid(source->'index')
            OR NOT vectorix_parent_offset_valid(source->'start')
            OR NOT vectorix_parent_offset_valid(source->'end') THEN RETURN false; END IF;
        IF (source->>'index')::integer > 4999 THEN RETURN false; END IF;
        first_span := (span->>'start')::integer; last_span := (span->>'end')::integer;
        source_first := (source->>'start')::integer; source_last := (source->>'end')::integer;
        IF first_span < first_offset OR last_span > last_offset OR first_span >= last_span
            OR source_first > first_span OR source_last < last_span THEN RETURN false; END IF;
    END LOOP;
    RETURN true;
END;
$$;

CREATE FUNCTION vectorix_parent_chunk_row() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context_version text;
BEGIN
    -- Identity cannot move between an admitted owner and a historical owner to
    -- escape its mutation gate. Existing workers never reparent Chunk records.
    IF TG_OP='UPDATE' AND (NEW.id,NEW."organizationId",NEW."generationId",NEW."indexedDocumentId") IS DISTINCT FROM
        (OLD.id,OLD."organizationId",OLD."generationId",OLD."indexedDocumentId") THEN
        RAISE EXCEPTION 'Chunk identity is immutable' USING ERRCODE='23514', CONSTRAINT='Chunk_layout_immutable';
    END IF;
    SELECT generation."parentContextVersion" INTO context_version FROM "IndexedDocument" candidate
        JOIN "IndexGeneration" generation ON generation.id=candidate."generationId"
        WHERE candidate.id=NEW."indexedDocumentId" AND candidate."organizationId"=NEW."organizationId"
            AND candidate."generationId"=NEW."generationId";
    IF context_version IS NULL THEN
        IF NEW.kind='PARENT' OR NEW."parentId" IS NOT NULL THEN
            RAISE EXCEPTION 'Parent layout requires a saved descriptor' USING ERRCODE='23514', CONSTRAINT='Chunk_parent_shape';
        END IF;
        RETURN NEW;
    END IF;
    -- Materialization is create-only: interrupted retries compare exact rows.
    -- This includes directly assigned lexical tsvectors, not just visible text.
    IF TG_OP='UPDATE' AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION 'Canonical parent layout is immutable' USING ERRCODE='23514', CONSTRAINT='Chunk_layout_immutable';
    END IF;
    IF NEW."startOffset" IS NULL OR NEW."endOffset" IS NULL OR NEW."textHash" !~ '^[a-f0-9]{64}$'
        OR NOT vectorix_parent_spans_valid(NEW."sourceSpans",NEW."startOffset",NEW."endOffset") THEN
        RAISE EXCEPTION 'Invalid canonical parent geometry' USING ERRCODE='23514', CONSTRAINT='Chunk_parent_geometry';
    END IF;
    IF (NEW.kind='PARENT' AND (NEW."parentId" IS NOT NULL OR NEW."embeddingInputHash" IS NOT NULL))
        OR (NEW.kind='CHILD' AND (NEW."parentId" IS NULL OR NEW."embeddingInputHash" IS NULL
            OR NEW."embeddingInputHash" !~ '^[a-f0-9]{64}$')) THEN
        RAISE EXCEPTION 'Invalid parent child shape' USING ERRCODE='23514', CONSTRAINT='Chunk_parent_shape';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_parent_chunk_row BEFORE INSERT OR UPDATE ON "Chunk"
FOR EACH ROW EXECUTE FUNCTION vectorix_parent_chunk_row();
CREATE TRIGGER vectorix_rag_chunk_org BEFORE INSERT OR UPDATE ON "Chunk"
FOR EACH ROW EXECUTE FUNCTION vectorix_rag_organization_lock();

CREATE FUNCTION vectorix_parent_chunk_link() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE child "Chunk"; parent "Chunk";
BEGIN
    -- Deferred checks inspect the committed form, allowing bounded staging
    -- batches and a complete CLEANING deletion of both parent and child rows.
    SELECT * INTO child FROM "Chunk" WHERE id=NEW.id;
    IF NOT FOUND OR child.kind<>'CHILD' OR child."parentId" IS NULL THEN RETURN NULL; END IF;
    SELECT * INTO parent FROM "Chunk" WHERE id=child."parentId" AND "organizationId"=child."organizationId"
        AND "indexedDocumentId"=child."indexedDocumentId";
    IF NOT FOUND OR parent.kind<>'PARENT' OR parent."parentId" IS NOT NULL
        OR parent."startOffset" IS NULL OR parent."endOffset" IS NULL
        OR child."startOffset" IS NULL OR child."endOffset" IS NULL
        OR parent."startOffset">child."startOffset" OR parent."endOffset"<child."endOffset" THEN
        RAISE EXCEPTION 'Invalid same candidate parent containment' USING ERRCODE='23514', CONSTRAINT='Chunk_parent_containment';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER vectorix_parent_chunk_link AFTER INSERT OR UPDATE ON "Chunk"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION vectorix_parent_chunk_link();

-- One real non-key UPDATE per distinct owner per statement closes stale
-- SERIALIZABLE snapshots against READ COMMITTED writers. A SELECT lock alone
-- does not change the owner tuple and was demonstrated insufficient.
CREATE FUNCTION vectorix_parent_chunk_touch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; context_version text;
BEGIN
    FOR owner_id IN
        SELECT id FROM (
            SELECT DISTINCT "indexedDocumentId" AS id FROM changed_new
            UNION SELECT DISTINCT "indexedDocumentId" AS id FROM changed_old
        ) owners ORDER BY id
    LOOP
        SELECT generation."parentContextVersion" INTO context_version FROM "IndexedDocument" candidate
            JOIN "IndexGeneration" generation ON generation.id=candidate."generationId" WHERE candidate.id=owner_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Parent layout owner is missing' USING ERRCODE='23503', CONSTRAINT='Chunk_parent_owner';
        END IF;
        IF context_version IS NULL THEN CONTINUE; END IF;
        UPDATE "IndexedDocument" SET "updatedAt"=clock_timestamp() WHERE id=owner_id AND status='STAGING';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Application parent layout is frozen' USING ERRCODE='23514', CONSTRAINT='Chunk_layout_frozen';
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
-- Separate event functions avoid referring to a transition table that does not
-- exist for that event; UPDATE receives both old and new owner identities.
CREATE FUNCTION vectorix_parent_chunk_insert_touch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; context_version text;
BEGIN
    FOR owner_id IN SELECT DISTINCT "indexedDocumentId" FROM changed_new ORDER BY "indexedDocumentId" LOOP
        SELECT generation."parentContextVersion" INTO context_version FROM "IndexedDocument" candidate
            JOIN "IndexGeneration" generation ON generation.id=candidate."generationId" WHERE candidate.id=owner_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Parent layout owner is missing' USING ERRCODE='23503', CONSTRAINT='Chunk_parent_owner'; END IF;
        IF context_version IS NOT NULL THEN
            UPDATE "IndexedDocument" SET "updatedAt"=clock_timestamp() WHERE id=owner_id AND status='STAGING';
            IF NOT FOUND THEN RAISE EXCEPTION 'Application parent layout is frozen' USING ERRCODE='23514', CONSTRAINT='Chunk_layout_frozen'; END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE FUNCTION vectorix_parent_chunk_delete_touch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id text; context_version text;
BEGIN
    FOR owner_id IN SELECT DISTINCT "indexedDocumentId" FROM changed_old ORDER BY "indexedDocumentId" LOOP
        SELECT generation."parentContextVersion" INTO context_version FROM "IndexedDocument" candidate
            JOIN "IndexGeneration" generation ON generation.id=candidate."generationId" WHERE candidate.id=owner_id;
        IF FOUND AND context_version IS NOT NULL THEN
            UPDATE "IndexedDocument" SET "updatedAt"=clock_timestamp() WHERE id=owner_id AND status='CLEANING';
            IF NOT FOUND THEN RAISE EXCEPTION 'Parent layout requires cleanup' USING ERRCODE='23514', CONSTRAINT='Chunk_layout_frozen'; END IF;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$$;
CREATE TRIGGER vectorix_parent_chunk_insert_touch AFTER INSERT ON "Chunk"
REFERENCING NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION vectorix_parent_chunk_insert_touch();
CREATE TRIGGER vectorix_parent_chunk_update_touch AFTER UPDATE ON "Chunk"
REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION vectorix_parent_chunk_touch();
CREATE TRIGGER vectorix_parent_chunk_delete_touch AFTER DELETE ON "Chunk"
REFERENCING OLD TABLE AS changed_old FOR EACH STATEMENT EXECUTE FUNCTION vectorix_parent_chunk_delete_touch();

CREATE FUNCTION vectorix_parent_candidate_layout(candidate "IndexedDocument") RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE children bigint; parents bigint; linked_parents bigint; first_child integer; last_child integer;
    first_parent integer; last_parent integer; text_bytes bigint; provenance_bytes bigint; parent_limit integer; size_text text;
BEGIN
    SELECT config.chunking->>'parentMaxTokens' INTO size_text FROM "CollectionConfigRevision" config
        JOIN "IndexGeneration" generation ON generation."organizationId"=config."organizationId"
            AND generation."collectionId"=config."collectionId" AND generation."configurationRevision"=config.revision
        WHERE generation.id=candidate."generationId";
    IF size_text IS NULL OR size_text !~ '^[0-9]{1,5}$' THEN RETURN false; END IF;
    IF size_text::integer NOT BETWEEN 32 AND 32768 THEN RETURN false; END IF;
    parent_limit := least(size_text::integer*3,49152);
    SELECT count(*) FILTER (WHERE kind='CHILD'),count(*) FILTER (WHERE kind='PARENT'),
        count(DISTINCT "parentId") FILTER (WHERE kind='CHILD'),
        min(ordinal) FILTER (WHERE kind='CHILD'),max(ordinal) FILTER (WHERE kind='CHILD'),
        min(ordinal) FILTER (WHERE kind='PARENT'),max(ordinal) FILTER (WHERE kind='PARENT'),
        coalesce(sum(octet_length(text)),0),coalesce(sum(octet_length("sourceSpans"::text)),0)
    INTO children,parents,linked_parents,first_child,last_child,first_parent,last_parent,text_bytes,provenance_bytes
    FROM "Chunk" WHERE "organizationId"=candidate."organizationId" AND "indexedDocumentId"=candidate.id;
    IF children NOT BETWEEN 1 AND 100000 OR parents NOT BETWEEN 1 AND children OR linked_parents<>parents
        OR children<>candidate."chunkCount" OR children<>candidate."materializedChunks"
        OR first_child<>0 OR last_child<>children-1 OR first_parent<>children OR last_parent<>children+parents-1
        OR text_bytes>134217728 OR provenance_bytes>67108864 THEN RETURN false; END IF;
    IF EXISTS (SELECT 1 FROM "Chunk" child LEFT JOIN "Chunk" parent
        ON parent.id=child."parentId" AND parent."organizationId"=child."organizationId" AND parent."indexedDocumentId"=child."indexedDocumentId"
        WHERE child."indexedDocumentId"=candidate.id AND (child."startOffset" IS NULL OR child."endOffset" IS NULL
            OR (child.kind='PARENT' AND (child."parentId" IS NOT NULL OR child."embeddingInputHash" IS NOT NULL OR octet_length(child.text)>parent_limit))
            OR (child.kind='CHILD' AND (parent.id IS NULL OR parent.kind<>'PARENT'
                OR parent."startOffset">child."startOffset" OR parent."endOffset"<child."endOffset")))) THEN RETURN false; END IF;
    RETURN true;
END;
$$;
CREATE FUNCTION vectorix_parent_candidate_state() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE context_version text; generation_state "IndexGenerationStatus";
BEGIN
    IF TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM "IndexGeneration" WHERE id=OLD."generationId" AND "parentContextVersion" IS NOT NULL)
        AND (NEW.id,NEW."organizationId",NEW."collectionId",NEW."generationId",NEW."documentId",NEW."sourceVersionId",NEW."extractionId",
            NEW."extractorVersion",NEW."buildRevision",NEW."metadataRevision",NEW."sourceChangeSequence",NEW."fileName",NEW."mediaType",
            NEW.language,NEW.tags,NEW.metadata,NEW."documentCreatedAt",NEW."sourceCreatedAt",NEW."createdAt") IS DISTINCT FROM
            (OLD.id,OLD."organizationId",OLD."collectionId",OLD."generationId",OLD."documentId",OLD."sourceVersionId",OLD."extractionId",
            OLD."extractorVersion",OLD."buildRevision",OLD."metadataRevision",OLD."sourceChangeSequence",OLD."fileName",OLD."mediaType",
            OLD.language,OLD.tags,OLD.metadata,OLD."documentCreatedAt",OLD."sourceCreatedAt",OLD."createdAt") THEN
        RAISE EXCEPTION 'Parent candidate identity is immutable' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_immutable';
    END IF;
    SELECT "parentContextVersion",status INTO context_version,generation_state FROM "IndexGeneration" WHERE id=NEW."generationId";
    IF context_version IS NULL THEN RETURN NEW; END IF;
    IF TG_OP='INSERT' THEN
        IF NEW.status<>'STAGING' OR generation_state NOT IN ('PROVISIONING','BUILDING','ACTIVE','FAILED') THEN
            RAISE EXCEPTION 'Parent candidate must start in staging' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_transition';
        END IF;
    ELSE
        IF (OLD.status<>'STAGING' AND NEW.status='STAGING') OR (OLD.status='CLEANED' AND NEW.status<>'CLEANED') THEN
            RAISE EXCEPTION 'Parent layout cannot reopen' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_transition';
        END IF;
        IF OLD.status<>'STAGING' AND (to_jsonb(NEW)-ARRAY['status','updatedAt','retiredAt','publishedAt','vectorSealedAt','materializedChunks']) IS DISTINCT FROM
            (to_jsonb(OLD)-ARRAY['status','updatedAt','retiredAt','publishedAt','vectorSealedAt','materializedChunks']) THEN
            RAISE EXCEPTION 'Sealed parent identity is immutable' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_immutable';
        END IF;
        IF (OLD."vectorSealedAt" IS NOT NULL AND NEW."vectorSealedAt" IS DISTINCT FROM OLD."vectorSealedAt")
            OR (OLD."publishedAt" IS NOT NULL AND NEW."publishedAt" IS DISTINCT FROM OLD."publishedAt")
            OR (NEW.status<>'CLEANED' AND OLD.status<>'STAGING' AND NEW."materializedChunks"<>OLD."materializedChunks") THEN
            RAISE EXCEPTION 'Sealed parent evidence is immutable' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_immutable';
        END IF;
        IF NEW.status='SEALED' AND OLD.status NOT IN ('STAGING','SEALED') THEN
            RAISE EXCEPTION 'Parent layout cannot reseal' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_transition';
        END IF;
        IF NEW.status='PUBLISHED' AND OLD.status NOT IN ('SEALED','PUBLISHED') THEN
            RAISE EXCEPTION 'Parent publication requires application seal' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_transition';
        END IF;
        IF NEW.status='CLEANING' AND OLD.status NOT IN ('RETIRED','CLEANING') THEN
            RAISE EXCEPTION 'Parent cleanup requires retirement' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_transition';
        END IF;
        IF NEW.status='CLEANED' AND OLD.status NOT IN ('CLEANING','CLEANED') THEN
            RAISE EXCEPTION 'Parent cleanup is incomplete' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_transition';
        END IF;
    END IF;
    IF NEW.status='STAGING' AND (NEW."manifestHash" IS NOT NULL OR NEW."vectorSealedAt" IS NOT NULL OR NEW."publishedAt" IS NOT NULL) THEN
        RAISE EXCEPTION 'Unsealed parent evidence is invalid' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_layout';
    END IF;
    IF NEW.status='SEALED' THEN
        IF NEW."manifestHash" IS NULL OR NEW."manifestHash" !~ '^[a-f0-9]{64}$'
            OR NEW."vectorSealedAt" IS NOT NULL OR NEW."publishedAt" IS NOT NULL
            OR (TG_OP='UPDATE' AND OLD.status='STAGING' AND NOT vectorix_parent_candidate_layout(NEW)) THEN
            RAISE EXCEPTION 'Application parent layout is incomplete' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_layout';
        END IF;
    END IF;
    IF NEW.status='PUBLISHED' AND (NEW."manifestHash" IS NULL OR NEW."vectorSealedAt" IS NULL OR NEW."publishedAt" IS NULL) THEN
        RAISE EXCEPTION 'Parent vector acknowledgment is missing' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_layout';
    END IF;
    IF NEW.status='CLEANED' AND (NEW."materializedChunks"<>0 OR EXISTS (SELECT 1 FROM "Chunk" WHERE "indexedDocumentId"=NEW.id)
        OR EXISTS (SELECT 1 FROM "SemanticChunkPlan" WHERE "indexedDocumentId"=NEW.id AND state<>'CLEANED')
        OR EXISTS (SELECT 1 FROM "EmbeddingWorkAttempt" WHERE "indexedDocumentId"=NEW.id
            AND (state IN ('RESERVED','IN_FLIGHT') OR "reservedPreparedBytes"<>0 OR "reservedBatches"<>0))) THEN
        RAISE EXCEPTION 'Parent content requires physical cleanup' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_cleanup';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER vectorix_parent_candidate_state BEFORE INSERT OR UPDATE ON "IndexedDocument"
FOR EACH ROW EXECUTE FUNCTION vectorix_parent_candidate_state();

CREATE FUNCTION vectorix_parent_candidate_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "IndexGeneration" WHERE id=OLD."generationId" AND "parentContextVersion" IS NOT NULL)
        AND (OLD.status<>'CLEANED' OR EXISTS (SELECT 1 FROM "Chunk" WHERE "indexedDocumentId"=OLD.id)) THEN
        RAISE EXCEPTION 'Parent candidate requires cleanup' USING ERRCODE='23514', CONSTRAINT='IndexedDocument_parent_cleanup';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER vectorix_parent_candidate_delete BEFORE DELETE ON "IndexedDocument"
FOR EACH ROW EXECUTE FUNCTION vectorix_parent_candidate_delete();
CREATE FUNCTION vectorix_parent_generation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD."parentContextVersion" IS NOT NULL AND (OLD.status<>'CLEANED'
        OR EXISTS (SELECT 1 FROM "IndexedDocument" WHERE "generationId"=OLD.id AND status<>'CLEANED')
        OR EXISTS (SELECT 1 FROM "Chunk" WHERE "generationId"=OLD.id)) THEN
        RAISE EXCEPTION 'Parent generation requires cleanup' USING ERRCODE='23514', CONSTRAINT='IndexGeneration_parent_cleanup';
    END IF;
    RETURN OLD;
END;
$$;
CREATE TRIGGER vectorix_parent_generation_delete BEFORE DELETE ON "IndexGeneration"
FOR EACH ROW EXECUTE FUNCTION vectorix_parent_generation_delete();

CREATE OR REPLACE FUNCTION vectorix_chunk_lexical() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.kind='PARENT' THEN
        NEW."lexicalFrench" := ''::tsvector; NEW."lexicalEnglish" := ''::tsvector; NEW."lexicalSimple" := ''::tsvector;
    ELSE
        NEW."lexicalFrench" := to_tsvector('french'::regconfig,NEW.text);
        NEW."lexicalEnglish" := to_tsvector('english'::regconfig,NEW.text);
        NEW."lexicalSimple" := to_tsvector('simple'::regconfig,NEW.text);
    END IF;
    RETURN NEW;
END;
$$;
DROP TRIGGER vectorix_chunk_lexical ON "Chunk";
CREATE TRIGGER vectorix_chunk_lexical BEFORE INSERT OR UPDATE OF text,kind ON "Chunk"
FOR EACH ROW EXECUTE FUNCTION vectorix_chunk_lexical();

CREATE OR REPLACE FUNCTION vectorix_rag_organization_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM "DocumentVersion" WHERE "organizationId"=OLD.id AND ("discardedAt" IS NULL OR "contentState"<>'PURGED'))
        OR EXISTS (SELECT 1 FROM "DocumentIngestion" WHERE "organizationId"=OLD.id AND "reservedBytes">0)
        OR EXISTS (SELECT 1 FROM "DocumentCleanup" WHERE "organizationId"=OLD.id AND status<>'COMPLETE')
        OR EXISTS (SELECT 1 FROM "IndexGeneration" WHERE "organizationId"=OLD.id AND status<>'CLEANED')
        OR EXISTS (SELECT 1 FROM "Chunk" WHERE "organizationId"=OLD.id)
        OR EXISTS (SELECT 1 FROM "SemanticChunkPlan" WHERE "organizationId"=OLD.id
            AND (state<>'CLEANED' OR "reservedBytes"<>0 OR "storedBytes"<>0 OR "reservedPreparedBytes"<>0 OR "reservedBatches"<>0
                OR "lastUnitVector" IS NOT NULL OR "unitRanges"<>'[]'::jsonb OR "boundaryScores"<>'[]'::jsonb OR "finalRanges" IS NOT NULL))
        OR EXISTS (SELECT 1 FROM "EmbeddingWorkAttempt" WHERE "organizationId"=OLD.id
            AND (state IN ('RESERVED','IN_FLIGHT') OR "reservedPreparedBytes"<>0 OR "reservedBatches"<>0))
        OR EXISTS (SELECT 1 FROM "OrganizationEmbeddingAccounting" WHERE "organizationId"=OLD.id
            AND ("reservedPlanBytes"<>0 OR "storedPlanBytes"<>0 OR "reservedPreparedBytes"<>0 OR "reservedBatches"<>0)) THEN
        RAISE EXCEPTION 'Delete RAG collections and documents, then wait for cleanup before deleting the organization'
            USING ERRCODE='23514', CONSTRAINT='organization_rag_cleanup_required';
    END IF;
    RETURN OLD;
END;
$$;

