DO $$ BEGIN
    IF (SELECT "reservedBytes" FROM "DocumentIngestion" WHERE "versionId" = 'upgrade-pending-version') IS DISTINCT FROM 17::bigint
       OR (SELECT attempts FROM "DocumentIngestion" WHERE "versionId" = 'upgrade-pending-version') IS DISTINCT FROM 2
       OR (SELECT "leaseToken" FROM "DocumentIngestion" WHERE "versionId" = 'upgrade-pending-version') IS DISTINCT FROM 'retained-token'
       OR (SELECT "objectKey" FROM "DocumentVersion" WHERE id = 'upgrade-pending-version') IS DISTINCT FROM 'pending-original'
       OR EXISTS (SELECT FROM "DocumentVersion" WHERE "fileName" IS NOT NULL)
       OR EXISTS (SELECT FROM "DocumentCleanup")
    THEN RAISE EXCEPTION 'Lifecycle migration changed upload state or scheduled implicit deletion'; END IF;
END $$;
