DO $$ BEGIN
    IF (SELECT "contentState" FROM "DocumentVersion" WHERE id = 'upgrade-purged-version') IS DISTINCT FROM 'PURGED'::"DocumentContentState"
       OR (SELECT "discardedAt" FROM "DocumentExtraction" WHERE id = 'upgrade-purged-extraction') IS DISTINCT FROM '2026-10-20T12:00:00Z'::timestamp
       OR (SELECT "contentState" FROM "DocumentVersion" WHERE id = 'upgrade-version') IS DISTINCT FROM 'AVAILABLE'::"DocumentContentState"
       OR EXISTS (SELECT FROM "DocumentExtraction" WHERE id = 'upgrade-extraction' AND "discardedAt" IS NOT NULL)
       OR EXISTS (SELECT FROM "IndexGeneration") OR EXISTS (SELECT FROM "IndexTask")
       OR EXISTS (SELECT FROM "DocumentSourceHold") OR EXISTS (SELECT FROM "CollectionChange")
    THEN RAISE EXCEPTION 'Indexing migration revived purged content, changed retained content, or implicitly started indexing'; END IF;
END $$;
