DO $$ BEGIN
    IF (SELECT name FROM "user" WHERE id = 'upgrade-user') IS DISTINCT FROM 'Existing user'
       OR (SELECT name FROM organization WHERE id = 'upgrade-org') IS DISTINCT FROM 'Existing organization'
       OR (SELECT role FROM member WHERE id = 'upgrade-member') IS DISTINCT FROM 'owner'
       OR (SELECT permissions FROM apikey WHERE id = 'upgrade-key') IS DISTINCT FROM '{"settings":["read"]}'
       OR (SELECT value FROM "OrganizationSetting" WHERE id = 'upgrade-setting') IS DISTINCT FROM 'existing-value'
    THEN RAISE EXCEPTION 'Existing data was not preserved'; END IF;
    IF EXISTS (SELECT FROM "ApiKeyPrincipal") OR EXISTS (SELECT FROM "ApiKeyCollectionScope")
       OR EXISTS (SELECT FROM "CollectionMemberGrant") OR EXISTS (SELECT FROM "CollectionGroupGrant")
    THEN RAISE EXCEPTION 'Migration granted implicit RAG access'; END IF;
    IF (SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) <> 3
    THEN RAISE EXCEPTION 'Expected exactly three applied migrations'; END IF;
END $$;
