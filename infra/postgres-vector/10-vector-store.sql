-- Infrastructure bootstrap, separate from the application Prisma migrations.
-- Runs only on an empty data volume, or when explicitly replayed by an operator.
\set ON_ERROR_STOP on
\getenv provisioner_password VECTOR_PROVISIONER_PASSWORD
\getenv runtime_password VECTOR_RUNTIME_PASSWORD
CREATE EXTENSION IF NOT EXISTS vector VERSION '0.8.7';
CREATE EXTENSION IF NOT EXISTS vectorscale VERSION '0.9.1';
DO $$ BEGIN
    IF (SELECT extversion FROM pg_extension WHERE extname = 'vector') <> '0.8.7'
       OR (SELECT extversion FROM pg_extension WHERE extname = 'vectorscale') <> '0.9.1' THEN
        RAISE EXCEPTION 'Unexpected vector extension versions; review the upgrade before continuing';
    END IF;
END $$;
SELECT 'CREATE ROLE vectorix_indexer LOGIN' WHERE NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'vectorix_indexer'
) \gexec
SELECT 'CREATE ROLE vectorix_runtime LOGIN' WHERE NOT EXISTS (
    SELECT FROM pg_roles WHERE rolname = 'vectorix_runtime'
) \gexec
ALTER ROLE vectorix_indexer PASSWORD :'provisioner_password';
ALTER ROLE vectorix_runtime PASSWORD :'runtime_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE SCHEMA IF NOT EXISTS vector_collections AUTHORIZATION vectorix_indexer;
GRANT USAGE ON SCHEMA vector_collections TO vectorix_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE vectorix_indexer IN SCHEMA vector_collections
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vectorix_runtime;
