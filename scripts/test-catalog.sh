#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Own disposable containers and databases; never load the developer's .env.
prefix="vectorix-catalog-${RANDOM}-$$"
cleanup() {
    result=$?
    if (( result != 0 )); then docker logs --tail 40 "$prefix-postgres" >&2 || true; fi
    docker rm -fv "$prefix-postgres" "$prefix-redis" >/dev/null 2>&1 || true
    exit "$result"
}
trap cleanup EXIT
docker run -d --name "$prefix-postgres" -p 127.0.0.1::5432 \
    -e POSTGRES_PASSWORD=catalog-test-password postgres:18-alpine >/dev/null
docker run -d --name "$prefix-redis" -p 127.0.0.1::6379 redis:8-alpine >/dev/null
ready=false
for attempt in {1..60}; do
    if docker exec "$prefix-postgres" pg_isready -U postgres >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
done
[[ "$ready" == true ]]
pg_port=$(docker port "$prefix-postgres" 5432/tcp | cut -d: -f2)
redis_port=$(docker port "$prefix-redis" 6379/tcp | cut -d: -f2)
sql() { docker exec -i "$prefix-postgres" psql -U postgres -d "$1" -v ON_ERROR_STOP=1; }
sql postgres <<< 'CREATE DATABASE vectorix_upgrade_test; CREATE DATABASE vectorix_catalog_test;'

# Start with phase 1, preserve existing data, then apply the approved additive migration.
sql vectorix_upgrade_test < packages/db/prisma/migrations/20261021000000_initial/migration.sql
sql vectorix_upgrade_test < tests/catalog/upgrade-seed.sql
export DATABASE_URL="postgresql://postgres:catalog-test-password@127.0.0.1:$pg_port/vectorix_upgrade_test"
pnpm --filter @repo/db exec prisma migrate resolve --applied 20261021000000_initial
for attempt in 1 2; do pnpm --filter @repo/db migrate:deploy; done
sql vectorix_upgrade_test < tests/catalog/upgrade-check.sql
pnpm --filter @repo/db exec prisma migrate diff --from-config-datasource --to-schema prisma --exit-code

# Also validate a fresh installation and a no-op repeat deployment.
export DATABASE_URL="postgresql://postgres:catalog-test-password@127.0.0.1:$pg_port/vectorix_catalog_test"
for attempt in 1 2; do pnpm --filter @repo/db migrate:deploy; done
pnpm --filter @repo/db exec prisma migrate diff --from-config-datasource --to-schema prisma --exit-code
export REDIS_URL="redis://127.0.0.1:$redis_port"
export BETTER_AUTH_SECRET=catalog-integration-test-only-secret-12345678
export ENCRYPTION_SECRET=1111111111111111111111111111111111111111111111111111111111111111
export BETTER_AUTH_URL=http://localhost:3001
export TRUSTED_ORIGINS=http://localhost:3000,http://localhost:3006
export ROOT_DOMAIN= BETTER_AUTH_COOKIE_NAME= BETTER_AUTH_COOKIE_PREFIX=
export ALLOW_ACCOUNT_CREATION=true ALLOW_ORGANIZATION_CREATION=true
export VECTORIX_FEATURE_PROVIDER_URL= VECTORIX_DEFAULT_RESEND_API_KEY= VECTORIX_DEFAULT_SMTP_HOST=
export VECTORIX_WEB_PUSH_ENABLED=false
pnpm --filter api test:integration
printf 'Fresh install, upgrade, repeat deployment, schema parity, core journeys, and RAG access tests passed.\n'
