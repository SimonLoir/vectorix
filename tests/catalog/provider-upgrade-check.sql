DO $$ BEGIN
    IF (SELECT revision FROM "Credentials" WHERE id = 'upgrade-credential') IS DISTINCT FROM 4
       OR (SELECT "apiKey" FROM "CohereCredentials" WHERE id = 'upgrade-credential') IS DISTINCT FROM 'preserved-ciphertext-fixture'
       OR (SELECT "credentialId" FROM "CredentialSelection" WHERE "organizationId" = 'upgrade-org' AND provider = 'COHERE') IS DISTINCT FROM 'upgrade-credential'
    THEN RAISE EXCEPTION 'Existing provider data was not preserved'; END IF;
    IF EXISTS (SELECT FROM "OpenAICredentials") OR EXISTS (SELECT FROM "MistralCredentials")
    THEN RAISE EXCEPTION 'Provider expansion created implicit credentials'; END IF;
    IF NOT ('OPENAI' = ANY(enum_range(NULL::"CredentialProvider")::text[]))
       OR NOT ('MISTRAL' = ANY(enum_range(NULL::"CredentialProvider")::text[]))
    THEN RAISE EXCEPTION 'New providers are missing'; END IF;
END $$;
