#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Own disposable containers and databases; never load the developer's .env.
prefix="vectorix-catalog-${RANDOM}-$$"
cleanup() {
    result=$?
    if (( result != 0 )); then docker logs --tail 40 "$prefix-postgres" >&2 || true; fi
    docker rm -fv "$prefix-postgres" "$prefix-redis" "$prefix-rustfs" "$prefix-vector" >/dev/null 2>&1 || true
    exit "$result"
}
trap cleanup EXIT
docker run -d --name "$prefix-postgres" -p 127.0.0.1::5432 \
    --label "vectorix.catalog-test=$prefix" \
    -e POSTGRES_PASSWORD=catalog-test-password postgres:18-alpine >/dev/null
docker run -d --name "$prefix-redis" -p 127.0.0.1::6379 redis:8-alpine >/dev/null
ready=false
# TCP excludes the entrypoint's temporary Unix-socket server during initialization.
for attempt in {1..60}; do
    if docker exec "$prefix-postgres" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
done
[[ "$ready" == true ]]
pg_port=$(docker port "$prefix-postgres" 5432/tcp | cut -d: -f2)
redis_port=$(docker port "$prefix-redis" 6379/tcp | cut -d: -f2)
sql() { docker exec -i "$prefix-postgres" psql -U postgres -d "$1" -v ON_ERROR_STOP=1; }
sql postgres <<< 'CREATE DATABASE vectorix_upgrade_test; CREATE DATABASE vectorix_catalog_test;'
docker cp tests/catalog "$prefix-postgres:/catalog-tests"
docker cp packages/db/prisma/migrations/20261031000000_sql_function_search_path/migration.sql "$prefix-postgres:/catalog-tests/sql-function-migration.sql"

# Preserve pre-catalog and catalog data through the approved additive migrations.
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261021000000_initial/migration.sql
sql vectorix_upgrade_test < tests/catalog/upgrade-seed.sql
export DATABASE_URL="postgresql://postgres:catalog-test-password@127.0.0.1:$pg_port/vectorix_upgrade_test"
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261021000000_initial
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261022000000_rag_catalog_access/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261022000000_rag_catalog_access
sql vectorix_upgrade_test < tests/catalog/provider-upgrade-seed.sql
sql vectorix_upgrade_test < tests/catalog/document-upgrade-seed.sql
for migration in 20261023000000_openai_mistral_credentials 20261024000000_document_ingestion; do
    sql vectorix_upgrade_test < "packages/db/prisma/migrations/$migration/migration.sql"
    pnpm --filter @repo/db exec prisma migrate resolve --applied "$migration"
done
sql vectorix_upgrade_test < tests/catalog/lifecycle-upgrade-seed.sql
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261025000000_document_lifecycle/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261025000000_document_lifecycle
sql vectorix_upgrade_test < tests/catalog/indexing-upgrade-seed.sql
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261026000000_rag_indexing/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261026000000_rag_indexing
sql vectorix_upgrade_test < tests/catalog/indexing-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/rebuild-upgrade-seed.sql
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261027000000_rag_rebuild/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261027000000_rag_rebuild
sql vectorix_upgrade_test < tests/catalog/semantic-upgrade-seed.sql
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261028000000_rag_semantic/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261028000000_rag_semantic
sql vectorix_upgrade_test < tests/catalog/semantic-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/parent-context-upgrade-seed.sql
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261029000000_rag_parent_context/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261029000000_rag_parent_context
sql vectorix_upgrade_test < tests/catalog/observability-upgrade-seed.sql
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261030000000_rag_observability/migration.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261030000000_rag_observability
docker exec "$prefix-postgres" psql -X -q -U postgres -d vectorix_upgrade_test -v ON_ERROR_STOP=1 -f /catalog-tests/sql-function-upgrade-check.sql
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261031000000_sql_function_search_path
for attempt in 1 2; do pnpm --filter @repo/db migrate:deploy; done
sql vectorix_upgrade_test < tests/catalog/observability-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/observability-schema-check.sql
sql vectorix_upgrade_test < tests/catalog/lifecycle-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/rebuild-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/provider-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/document-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/parent-context-upgrade-check.sql
sql vectorix_upgrade_test < tests/catalog/semantic-schema-check.sql
docker exec "$prefix-postgres" psql -X -q -U postgres -d vectorix_upgrade_test -v ON_ERROR_STOP=1 -f /catalog-tests/parent-context-schema-check.sql
docker exec "$prefix-postgres" psql -X -q -U postgres -d vectorix_upgrade_test -v ON_ERROR_STOP=1 -f /catalog-tests/sql-function-path-check.sql
pnpm --filter @repo/db exec prisma migrate diff --from-config-datasource --to-schema prisma --exit-code

# Also validate a fresh installation and a no-op repeat deployment.
export DATABASE_URL="postgresql://postgres:catalog-test-password@127.0.0.1:$pg_port/vectorix_catalog_test"
for attempt in 1 2; do pnpm --filter @repo/db migrate:deploy; done
sql vectorix_catalog_test < tests/catalog/observability-schema-check.sql
sql vectorix_catalog_test < tests/catalog/semantic-schema-check.sql
docker exec "$prefix-postgres" psql -X -q -U postgres -d vectorix_catalog_test -v ON_ERROR_STOP=1 -f /catalog-tests/parent-context-schema-check.sql
docker exec "$prefix-postgres" psql -X -q -U postgres -d vectorix_catalog_test -v ON_ERROR_STOP=1 -f /catalog-tests/sql-function-path-check.sql
pnpm --filter @repo/db exec prisma migrate diff --from-config-datasource --to-schema prisma --exit-code
node tests/catalog/semantic-lock-check.mjs
node tests/catalog/parent-context-lock-check.mjs
node tests/catalog/observability-lock-check.mjs
docker exec "$prefix-postgres" psql -X -q -U postgres -d vectorix_upgrade_test -v ON_ERROR_STOP=1 -f /catalog-tests/sql-function-restore-seed.sql
python3 -B tests/catalog/sql-function-restore-check.py "$prefix"
export REDIS_URL="redis://127.0.0.1:$redis_port"
export BETTER_AUTH_SECRET=catalog-integration-test-only-secret-12345678
export ENCRYPTION_SECRET=1111111111111111111111111111111111111111111111111111111111111111
export BETTER_AUTH_URL=http://localhost:3001
export TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3006
export ROOT_DOMAIN= BETTER_AUTH_COOKIE_NAME= BETTER_AUTH_COOKIE_PREFIX=
export ALLOW_ACCOUNT_CREATION=true ALLOW_ORGANIZATION_CREATION=true
export VECTORIX_FEATURE_PROVIDER_URL= VECTORIX_DEFAULT_RESEND_API_KEY= VECTORIX_DEFAULT_SMTP_HOST=
export VECTORIX_WEB_PUSH_ENABLED=false
# Functional journeys use finite high budgets; focused native tests observe actual admission and 429s.
export VECTORIX_API_RATE_LIMIT_PER_MINUTE=1000000 VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE=1000000 VECTORIX_API_ORGANIZATION_PROVIDER_RATE_LIMIT_PER_MINUTE=1000000
# Real private object storage for binary HTTP and extraction journeys.
docker run -d --name "$prefix-rustfs" -p 127.0.0.1::9000 \
    -e RUSTFS_ACCESS_KEY=catalog-storage -e RUSTFS_SECRET_KEY=catalog-storage-test-secret \
    -e RUSTFS_CONSOLE_ENABLE=false -e RUSTFS_OBS_LOG_DIRECTORY=/tmp/logs \
    rustfs/rustfs:1.0.3@sha256:9ca9559533b537d10482fe923288b676ad08f92a7069d9a17327fbae3cab688b /data >/dev/null
s3_port=$(docker port "$prefix-rustfs" 9000/tcp | cut -d: -f2)
export VECTORIX_DEFAULT_S3_ENDPOINT="http://127.0.0.1:$s3_port"
export VECTORIX_DEFAULT_S3_REGION=us-east-1 VECTORIX_DEFAULT_S3_BUCKET=catalog-documents
export VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=catalog-storage VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=catalog-storage-test-secret
export VECTORIX_DEFAULT_S3_FORCE_PATH_STYLE=true VECTORIX_S3_ALLOWED_ENDPOINTS=
ready=false
for attempt in {1..60}; do
    if curl -fsS "$VECTORIX_DEFAULT_S3_ENDPOINT/health" >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
done
[[ "$ready" == true ]]
docker run --rm --network "container:$prefix-rustfs" \
    -e AWS_ENDPOINT_URL=http://127.0.0.1:9000 -e AWS_ACCESS_KEY_ID="$VECTORIX_DEFAULT_S3_ACCESS_KEY_ID" \
    -e AWS_SECRET_ACCESS_KEY="$VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY" -e AWS_DEFAULT_REGION=us-east-1 \
    -e AWS_EC2_METADATA_DISABLED=true -e S3_BUCKET="$VECTORIX_DEFAULT_S3_BUCKET" \
    -v "$PWD/infra/s3:/scripts:ro" --entrypoint /bin/sh \
    amazon/aws-cli:2.31.22@sha256:bf253be91e12d49ba1bd6dc939a76ea9777901772032692b14639e643118e1c1 /scripts/init-bucket.sh
# Isolated native pgvector/pgvectorscale storage for first-index/search journeys.
docker run -d --name "$prefix-vector" -p 127.0.0.1::5432 \
    -e POSTGRES_PASSWORD=catalog-vector-admin -e POSTGRES_DB=vectorix_catalog_vectors_test \
    -e VECTOR_PROVISIONER_PASSWORD=catalog-vector-indexer -e VECTOR_RUNTIME_PASSWORD=catalog-vector-runtime \
    "${VECTOR_POSTGRES_IMAGE:-pxdv.be/vectorix/postgres-vector:local}" >/dev/null
ready=false
for attempt in {1..60}; do
    if docker exec "$prefix-vector" pg_isready -h 127.0.0.1 -U postgres -d vectorix_catalog_vectors_test >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
done
[[ "$ready" == true ]]
vector_port=$(docker port "$prefix-vector" 5432/tcp | cut -d: -f2)
export VECTOR_DATABASE_URL="postgresql://vectorix_runtime:catalog-vector-runtime@127.0.0.1:$vector_port/vectorix_catalog_vectors_test"
export VECTOR_DATABASE_PROVISIONING_URL="postgresql://vectorix_indexer:catalog-vector-indexer@127.0.0.1:$vector_port/vectorix_catalog_vectors_test"
export VECTOR_DATABASE_SCHEMA=vector_collections
export VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS=
pnpm --filter api test:integration
printf 'Fresh install, upgrade, repeat deployment, schema parity, core journeys, and RAG access tests passed.\n'
