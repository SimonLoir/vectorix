DO $$ BEGIN
    IF NOT EXISTS (
        SELECT FROM "IndexGeneration"
        WHERE id = '00000000-0000-4000-8000-000000000041'
          AND "previousGenerationId" IS NULL AND "authorityUserId" IS NULL
          AND status = 'ACTIVE' AND "createdBy" = 'upgrade-user'
          AND "configurationRevision" = 1 AND "modelIdentity" = repeat('d', 64)
          AND "activatedAt" = '2026-10-21T10:00:00Z'::timestamp
    ) OR (SELECT "activeGenerationId" FROM "Collection" WHERE id = 'upgrade-rebuild-collection')
          IS DISTINCT FROM '00000000-0000-4000-8000-000000000041'
    THEN RAISE EXCEPTION 'Rebuild migration altered a historical active generation'; END IF;
    IF NOT EXISTS (
        SELECT FROM pg_constraint
        WHERE conname = 'IndexGeneration_organizationId_collectionId_previousGenera_fkey'
          AND condeferrable AND condeferred
    ) THEN RAISE EXCEPTION 'Generation predecessor reference must remain deferred'; END IF;
END $$;
