-- Historical document catalog rows must survive without gaining tasks or storage confirmation.
INSERT INTO "StorageLocation" (id, "organizationId", fingerprint, endpoint, bucket, region, "forcePathStyle")
VALUES ('upgrade-storage', 'upgrade-org', 'retained-destination', 'https://storage.example.test', 'private-documents', 'us-east-1', true);
INSERT INTO "Document" (id, "organizationId", name, status, "updatedAt")
VALUES ('upgrade-document', 'upgrade-org', 'Existing document', 'READY', now());
INSERT INTO "DocumentVersion" (id, "organizationId", "documentId", version, "storageLocationId", "objectKey", sha256, "byteSize", "mediaType", status)
VALUES ('upgrade-version', 'upgrade-org', 'upgrade-document', 1, 'upgrade-storage', 'original', repeat('a', 64), 100, 'text/plain', 'READY');
INSERT INTO "DocumentExtraction" (id, "organizationId", "versionId", "storageLocationId", "objectKey", "byteSize", "extractorVersion", language)
VALUES ('upgrade-extraction', 'upgrade-org', 'upgrade-version', 'upgrade-storage', 'text', 50, 'existing-v1', 'fr');
