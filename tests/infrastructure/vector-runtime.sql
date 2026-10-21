\set ON_ERROR_STOP on
-- Run through a real runtime-role TCP connection, including after a restart.
SET enable_seqscan = off;
SET diskann.query_search_list_size = 256;
SET diskann.query_rescore = 256;
DO $$
DECLARE first_id integer;
BEGIN
    IF (SELECT rolsuper OR rolcreatedb OR rolcreaterole FROM pg_roles WHERE rolname = current_user) THEN
        RAISE EXCEPTION 'Runtime role has administrative privileges';
    END IF;
    SELECT id INTO first_id FROM vector_collections.collection_smoke
    WHERE document_id = 'document-1' ORDER BY embedding <=> '[1,0,0]' LIMIT 1;
    IF first_id IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Runtime cannot retrieve the indexed row'; END IF;
    BEGIN
        CREATE TABLE vector_collections.forbidden (id integer);
        RAISE EXCEPTION 'Runtime unexpectedly has schema CREATE rights';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        DROP TABLE vector_collections.collection_smoke;
        RAISE EXCEPTION 'Runtime unexpectedly has DROP rights';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
INSERT INTO vector_collections.collection_smoke VALUES (2048, 'runtime-write', '[0,1,0]');
UPDATE vector_collections.collection_smoke SET document_id = 'runtime-update' WHERE id = 2048;
DELETE FROM vector_collections.collection_smoke WHERE id = 2048;
