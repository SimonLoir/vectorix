-- Fixed identifiers are safe in the disposable upgrade database only.
INSERT INTO "user" (id, name, email) VALUES ('upgrade-user', 'Existing user', 'upgrade@example.test');
INSERT INTO organization (id, name, slug, "createdAt") VALUES ('upgrade-org', 'Existing organization', 'upgrade-org', now());
INSERT INTO member (id, "organizationId", "userId", role, "createdAt") VALUES ('upgrade-member', 'upgrade-org', 'upgrade-user', 'owner', now());
INSERT INTO apikey (id, "configId", "referenceId", key, permissions, "vectorixLegacyFullAccess", "createdAt", "updatedAt")
VALUES ('upgrade-key', 'org', 'upgrade-org', 'stored-key-hash', '{"settings":["read"]}', false, now(), now());
INSERT INTO "OrganizationSetting" (id, "organizationId", key, value) VALUES ('upgrade-setting', 'upgrade-org', 'preserved', 'existing-value');
