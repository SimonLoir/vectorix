-- A pre-M4 active generation must keep its pointer, immutable binding and
-- creator, without acquiring an invented predecessor or authority override.
INSERT INTO "VectorConnection" (id, "organizationId", "destinationFingerprint")
VALUES ('upgrade-rebuild-vector', 'upgrade-org', 'upgrade-rebuild-destination');
INSERT INTO "Collection" (id, "organizationId", name, "updatedAt")
VALUES ('upgrade-rebuild-collection', 'upgrade-org', 'Existing searchable collection', now());
INSERT INTO "CollectionConfigRevision" (id, "organizationId", "collectionId", revision, "vectorConnectionId", provider, model, dimensions, endpoint, chunking)
VALUES ('upgrade-rebuild-profile', 'upgrade-org', 'upgrade-rebuild-collection', 1, 'upgrade-rebuild-vector', 'OLLAMA', 'existing-model', 256, 'http://embedding.example.test', '{}');
INSERT INTO "IndexGeneration" (id, "organizationId", "collectionId", "requestId", "configurationRevision", "vectorConnectionId", "vectorSchema", "tableName", "destinationFingerprint", "modelIdentity", "capabilitySnapshot", "chunkerVersion", status, "createdBy", "updatedAt", "activatedAt")
VALUES ('00000000-0000-4000-8000-000000000041', 'upgrade-org', 'upgrade-rebuild-collection', 'upgrade-first-index-request', 1, 'upgrade-rebuild-vector', 'vector_collections', 'g_00000000000040008000000000000041', 'upgrade-rebuild-destination', repeat('d', 64), '{}', 'structure-utf8-v1', 'ACTIVE', 'upgrade-user', now(), '2026-10-21T10:00:00Z');
UPDATE "Collection" SET "activeGenerationId" = '00000000-0000-4000-8000-000000000041'
WHERE id = 'upgrade-rebuild-collection';
