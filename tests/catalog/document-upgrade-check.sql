DO $$ BEGIN
    IF (SELECT name FROM "Document" WHERE id = 'upgrade-document') IS DISTINCT FROM 'Existing document'
       OR (SELECT "byteSize" FROM "DocumentVersion" WHERE id = 'upgrade-version') IS DISTINCT FROM 100::bigint
       OR (SELECT "objectKey" FROM "DocumentVersion" WHERE id = 'upgrade-version') IS DISTINCT FROM 'original'
       OR (SELECT "byteSize" FROM "DocumentExtraction" WHERE id = 'upgrade-extraction') IS DISTINCT FROM 50::bigint
       OR EXISTS (SELECT FROM "DocumentVersion" WHERE id = 'upgrade-version' AND ("storedAt" IS NOT NULL OR "discardedAt" IS NOT NULL))
       OR EXISTS (SELECT FROM "DocumentIngestion")
    THEN RAISE EXCEPTION 'Document migration changed retained content or created automatic ingestion'; END IF;
END $$;
