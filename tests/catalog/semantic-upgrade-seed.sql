-- Pre-M6b rows in the disposable upgrade database must remain untracked history.
INSERT INTO "OrganizationQuota" ("organizationId", collections, documents, "originalBytes", "storageBytes", "chunksPerCollection", "temporaryChunksPerCollection", "updatedAt")
VALUES ('upgrade-org', 9, 123, 4567, 8910, 42, 21, now());
INSERT INTO "IndexedDocument" (id, "organizationId", "collectionId", "generationId", "documentId", "sourceVersionId", "extractionId", "extractorVersion", "buildRevision", "metadataRevision", "sourceChangeSequence", "fileName", "mediaType", language, "documentCreatedAt", "sourceCreatedAt", status, "updatedAt")
VALUES ('upgrade-semantic-historical-candidate', 'upgrade-org', 'upgrade-rebuild-collection', '00000000-0000-4000-8000-000000000041', 'upgrade-document', 'upgrade-version', 'upgrade-extraction', 'existing-v1', 1, 1, 0, 'Existing document', 'text/plain', 'FR', now(), now(), 'PUBLISHED', now());
INSERT INTO "IndexTask" (id, "organizationId", "collectionId", "generationId", "indexedDocumentId", kind, "dedupeKey", "requestedBy", status, stage, attempts, "leaseEpoch", "updatedAt")
VALUES ('upgrade-semantic-historical-task', 'upgrade-org', 'upgrade-rebuild-collection', '00000000-0000-4000-8000-000000000041', 'upgrade-semantic-historical-candidate', 'INDEX_DOCUMENT', 'historical-task', 'upgrade-user', 'FAILED', 'FAILED', 3, 7, now());
