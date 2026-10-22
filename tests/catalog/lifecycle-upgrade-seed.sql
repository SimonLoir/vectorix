-- Preserve an M2a.1 upload reservation through the lifecycle migration.
INSERT INTO "Document" (id, "organizationId", name, status, "updatedAt")
VALUES ('upgrade-pending-document', 'upgrade-org', 'Retained upload.txt', 'PROCESSING', now());
INSERT INTO "DocumentVersion" (id, "organizationId", "documentId", version, "storageLocationId", "objectKey", sha256, "byteSize", "mediaType", status, "storedAt")
VALUES ('upgrade-pending-version', 'upgrade-org', 'upgrade-pending-document', 1, 'upgrade-storage', 'pending-original', repeat('b', 64), 17, 'text/plain', 'PROCESSING', now());
INSERT INTO "DocumentIngestion" ("versionId", "organizationId", "requestId", "requestedBy", status, "reservedBytes", attempts, "leaseToken", "leasedUntil", "updatedAt")
VALUES ('upgrade-pending-version', 'upgrade-org', 'retained-request', 'upgrade-user', 'PROCESSING', 17, 2, 'retained-token', '2030-01-01', now());
