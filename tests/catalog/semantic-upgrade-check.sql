DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM "OrganizationQuota" WHERE "organizationId" = 'upgrade-org'
        AND collections = 9 AND documents = 123 AND "originalBytes" = 4567 AND "storageBytes" = 8910
        AND "chunksPerCollection" = 42 AND "temporaryChunksPerCollection" = 21
        AND "semanticUnitsPerDocument" = 8192 AND "semanticPlanBytesPerDocument" = 1048576
        AND "semanticPlanBytesPerOrganization" = 67108864 AND "embeddingPreparedBytesPerCandidate" = 134217728
        AND "embeddingBatchesPerCandidate" = 4096 AND "embeddingOutstandingPreparedBytes" = 536870912
        AND "embeddingOutstandingBatches" = 16384)
       OR NOT EXISTS (SELECT FROM "IndexTask" WHERE id = 'upgrade-semantic-historical-task'
        AND status = 'FAILED' AND attempts = 3 AND "leaseEpoch" = 7 AND NOT "continuationPending" AND continuations = 0)
       OR NOT EXISTS (SELECT FROM "IndexedDocument" WHERE id = 'upgrade-semantic-historical-candidate'
        AND status = 'PUBLISHED' AND "sourceVersionId" = 'upgrade-version' AND "buildRevision" = 1)
       OR EXISTS (SELECT FROM "SemanticChunkPlan") OR EXISTS (SELECT FROM "EmbeddingWorkAttempt")
       OR EXISTS (SELECT FROM "OrganizationEmbeddingAccounting")
    THEN RAISE EXCEPTION 'Semantic migration changed historical work or invented tracked usage'; END IF;
END $$;
