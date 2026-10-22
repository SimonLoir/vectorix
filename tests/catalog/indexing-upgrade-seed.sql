-- Historical physical purges must remain purged after source-hold fences arrive.
INSERT INTO "Document" (id, "organizationId", name, status, "updatedAt", "deletedAt")
VALUES ('upgrade-purged-document', 'upgrade-org', 'Purged historical document', 'DELETED', now(), now());
INSERT INTO "DocumentVersion" (id, "organizationId", "documentId", version, "storageLocationId", "objectKey", sha256, "byteSize", "mediaType", status, "discardedAt")
VALUES ('upgrade-purged-version', 'upgrade-org', 'upgrade-purged-document', 1, 'upgrade-storage', 'purged-original', repeat('c', 64), 19, 'text/plain', 'DELETED', '2026-10-20T12:00:00Z');
INSERT INTO "DocumentExtraction" (id, "organizationId", "versionId", "storageLocationId", "objectKey", "byteSize", "extractorVersion", language)
VALUES ('upgrade-purged-extraction', 'upgrade-org', 'upgrade-purged-version', 'upgrade-storage', 'purged-text', 11, 'utf8-text-v1', 'fr');
