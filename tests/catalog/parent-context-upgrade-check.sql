DO $$ BEGIN
    IF EXISTS(SELECT FROM "IndexGeneration" WHERE "parentContextVersion" IS NOT NULL)
        OR EXISTS(SELECT FROM "Chunk" WHERE "startOffset" IS NOT NULL OR "endOffset" IS NOT NULL)
        OR NOT EXISTS(SELECT FROM "Chunk" WHERE id='upgrade-parent-historical-child' AND kind='CHILD' AND "parentId" IS NULL AND "embeddingInputHash"=repeat('b',64))
        OR (SELECT to_jsonb(plan) FROM "SemanticChunkPlan" plan WHERE "indexedDocumentId"='upgrade-parent-semantic-candidate') IS DISTINCT FROM
            (SELECT details->'plan' FROM "RagAuditLog" WHERE id='upgrade-parent-snapshot')
        OR (SELECT to_jsonb(child)-ARRAY['startOffset','endOffset'] FROM "Chunk" child WHERE id='upgrade-parent-historical-child') IS DISTINCT FROM
            (SELECT details->'child' FROM "RagAuditLog" WHERE id='upgrade-parent-snapshot')
        OR NOT EXISTS(SELECT FROM "OrganizationEmbeddingAccounting" WHERE "organizationId"='upgrade-org' AND "storedPlanBytes"=1000 AND "reservedPlanBytes"=100
            AND "dispatchedBatches"=0 AND "observedSuccessfulRequests"=0) THEN
        RAISE EXCEPTION 'Parent migration altered historical chunks, semantic bindings/checkpoints or invented parent/work data';
    END IF;
END $$;
