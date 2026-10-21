\set ON_ERROR_STOP on
-- Database-specific DDL and extension queries deliberately use SQL in this infra check.
CREATE TABLE vector_collections.collection_smoke (
    id integer PRIMARY KEY,
    document_id text NOT NULL,
    embedding public.vector(3) NOT NULL
);
INSERT INTO vector_collections.collection_smoke
SELECT n, 'document-' || n,
    CASE WHEN n = 1 THEN '[1,0,0]'::public.vector
         ELSE ('[0,' || n || ',1]')::public.vector END
FROM generate_series(1, 1024) n;
CREATE INDEX collection_smoke_hnsw ON vector_collections.collection_smoke
    USING hnsw (embedding public.vector_cosine_ops);
SET enable_seqscan = off;
DO $$
DECLARE first_id integer; plan_line text; index_used boolean := false;
BEGIN
    SELECT id INTO first_id FROM vector_collections.collection_smoke
    ORDER BY embedding <=> '[1,0,0]' LIMIT 1;
    IF first_id IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Incorrect HNSW nearest neighbor'; END IF;
    FOR plan_line IN EXECUTE 'EXPLAIN SELECT id FROM vector_collections.collection_smoke ORDER BY embedding <=> ''[1,0,0]'' LIMIT 1' LOOP
        index_used := index_used OR position('collection_smoke_hnsw' IN plan_line) > 0;
    END LOOP;
    IF NOT index_used THEN RAISE EXCEPTION 'HNSW index was not used'; END IF;
END $$;
DROP INDEX vector_collections.collection_smoke_hnsw;
CREATE INDEX collection_smoke_diskann ON vector_collections.collection_smoke
    USING diskann (embedding public.vector_cosine_ops);
DO $$
DECLARE first_id integer; plan_line text; index_used boolean := false;
BEGIN
    SELECT id INTO first_id FROM vector_collections.collection_smoke
    ORDER BY embedding <=> '[1,0,0]' LIMIT 1;
    IF first_id IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'Incorrect DiskANN nearest neighbor'; END IF;
    FOR plan_line IN EXECUTE 'EXPLAIN SELECT id FROM vector_collections.collection_smoke ORDER BY embedding <=> ''[1,0,0]'' LIMIT 1' LOOP
        index_used := index_used OR position('collection_smoke_diskann' IN plan_line) > 0;
    END LOOP;
    IF NOT index_used THEN RAISE EXCEPTION 'DiskANN index was not used'; END IF;
    BEGIN
        CREATE TABLE public.forbidden (id integer);
        RAISE EXCEPTION 'Indexer unexpectedly has CREATE rights on public';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END $$;
