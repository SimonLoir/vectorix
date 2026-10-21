#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Unique project, explicit test settings, no host ports, no reads of the local .env.
prefix="vectorix-infra-${RANDOM}-$$"
image_prefix="${IMAGE_PREFIX:-$prefix}"
export VECTOR_POSTGRES_IMAGE="$image_prefix-postgres-vector:test"
export VECTOR_POSTGRES_PASSWORD=infra-admin-test-password
export VECTOR_PROVISIONER_PASSWORD=infra-indexer-test-password
export VECTOR_RUNTIME_PASSWORD=infra-runtime-test-password
export VECTORIX_DEFAULT_S3_ACCESS_KEY_ID=vectorix-infra-test
export VECTORIX_DEFAULT_S3_SECRET_ACCESS_KEY=vectorix-infra-test-secret
export VECTORIX_DEFAULT_S3_REGION=us-east-1
export VECTORIX_DEFAULT_S3_BUCKET=vectorix-infra-test
compose=(docker compose --project-name "$prefix" --env-file /dev/null -f docker-compose.yml -f tests/infrastructure/compose.yml)
owned_migrator=false
migrator="${MIGRATOR_IMAGE:-$prefix-migrator:test}"
cleanup() {
    result=$?
    if (( result != 0 )); then "${compose[@]}" logs --tail 80 >&2 || true; fi
    "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
    if [[ "$owned_migrator" == true ]]; then docker image rm "$migrator" >/dev/null 2>&1 || true; fi
    if (( result != 0 )) || [[ "${KEEP_IMAGES:-false}" != true ]]; then
        docker image rm "$VECTOR_POSTGRES_IMAGE" >/dev/null 2>&1 || true
    fi
    exit "$result"
}
trap cleanup EXIT
"${compose[@]}" config --quiet
"${compose[@]}" build postgres-vector
if [[ -z "${MIGRATOR_IMAGE:-}" ]]; then
    owned_migrator=true
    docker build -f packages/db/Dockerfile -t "$migrator" .
fi
"${compose[@]}" up -d --wait --wait-timeout 180 postgres redis postgres-vector rustfs
# Repeat both bootstrap operations to verify that an explicit replay is safe.
"${compose[@]}" exec -T postgres-vector psql -U postgres -d vectorix_vectors -f /docker-entrypoint-initdb.d/10-vector-store.sql
"${compose[@]}" run --rm --interactive=false s3-init
"${compose[@]}" run --rm --interactive=false s3-init
network="${prefix}_default"
for attempt in 1 2; do
    docker run --rm --interactive=false --network "$network" \
        -e DATABASE_URL=postgresql://postgres:password@postgres:5432/vectorix_test "$migrator"
done
"${compose[@]}" exec -T postgres psql -U postgres -d vectorix_test -v ON_ERROR_STOP=1 -c \
    "SELECT count(*) FROM _prisma_migrations; DO \$\$ BEGIN IF EXISTS (SELECT FROM pg_extension WHERE extname IN ('vector', 'vectorscale')) THEN RAISE EXCEPTION 'Vector extensions leaked into the catalog'; END IF; END \$\$;"
"${compose[@]}" exec -T postgres-vector psql -U postgres -d vectorix_vectors -v ON_ERROR_STOP=1 -c \
    "SELECT name, installed_version FROM pg_available_extensions WHERE name IN ('vector', 'vectorscale'); DO \$\$ BEGIN IF to_regclass('public._prisma_migrations') IS NOT NULL THEN RAISE EXCEPTION 'Catalog migrations leaked into vector storage'; END IF; END \$\$;"
indexer() {
    "${compose[@]}" exec -T postgres-vector sh -ec \
        'export PGPASSWORD="$VECTOR_PROVISIONER_PASSWORD"; exec psql -h 127.0.0.1 -U vectorix_indexer -d vectorix_vectors -v ON_ERROR_STOP=1'
}
runtime() {
    "${compose[@]}" exec -T postgres-vector sh -ec \
        'export PGPASSWORD="$VECTOR_RUNTIME_PASSWORD"; exec psql -h 127.0.0.1 -U vectorix_runtime -d vectorix_vectors -v ON_ERROR_STOP=1'
}
indexer < tests/infrastructure/vector-indexes.sql
runtime < tests/infrastructure/vector-runtime.sql
"${compose[@]}" run --rm --interactive=false --no-deps --entrypoint sh s3-init /checks/s3.sh write
"${compose[@]}" run --rm --interactive=false --no-deps --entrypoint sh s3-init /checks/s3.sh read
anonymous_status=$("${compose[@]}" exec -T rustfs curl -s -o /dev/null -w '%{http_code}' \
    "http://127.0.0.1:9000/$VECTORIX_DEFAULT_S3_BUCKET/checks/private-document.bin")
[[ "$anonymous_status" == 403 ]]
# Restart without deleting volumes: vectors and originals must both survive.
"${compose[@]}" restart postgres-vector rustfs
"${compose[@]}" up -d --wait --wait-timeout 180 postgres-vector rustfs
runtime < tests/infrastructure/vector-runtime.sql
"${compose[@]}" run --rm --interactive=false --no-deps --entrypoint sh s3-init /checks/s3.sh read
"${compose[@]}" run --rm --interactive=false --no-deps --entrypoint sh s3-init /checks/s3.sh delete
printf 'Vector extensions, indexes, role boundaries, catalog migrations, and private S3 storage passed.\n'
