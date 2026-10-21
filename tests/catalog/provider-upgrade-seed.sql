-- Existing catalog rows must survive the provider expansion unchanged.
INSERT INTO "Credentials" (id, "organizationId", name, provider, revision, "updatedAt")
VALUES ('upgrade-credential', 'upgrade-org', 'Existing Cohere', 'COHERE', 4, now());
INSERT INTO "CohereCredentials" (id, endpoint, "apiKey")
VALUES ('upgrade-credential', 'https://existing-provider.test', 'preserved-ciphertext-fixture');
INSERT INTO "CredentialSelection" ("organizationId", provider, "credentialId")
VALUES ('upgrade-org', 'COHERE', 'upgrade-credential');
