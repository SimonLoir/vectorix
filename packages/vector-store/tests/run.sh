#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
name="vectorix-m3-adapter-$RANDOM-$$"
cleanup(){ result=$?; if ((result)); then docker logs --tail 30 "$name" >&2 || true; fi; docker rm -fv "$name" >/dev/null 2>&1 || true; exit "$result"; }
trap cleanup EXIT
docker run -d --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=adapter-test-admin -e POSTGRES_DB=vectorix_vector_adapter_test -e VECTOR_PROVISIONER_PASSWORD=adapter-test-indexer -e VECTOR_RUNTIME_PASSWORD=adapter-test-runtime "${VECTOR_POSTGRES_IMAGE:-pxdv.be/vectorix/postgres-vector:local}" >/dev/null
for attempt in {1..60}; do if docker exec "$name" pg_isready -U postgres -d vectorix_vector_adapter_test >/dev/null 2>&1; then break; fi; sleep 1; done
port=$(docker port "$name" 5432/tcp | cut -d: -f2)
export VECTOR_ADAPTER_TEST_CONFIG="{\"runtimeUrl\":\"postgresql://vectorix_runtime:adapter-test-runtime@127.0.0.1:$port/vectorix_vector_adapter_test\",\"provisioningUrl\":\"postgresql://vectorix_indexer:adapter-test-indexer@127.0.0.1:$port/vectorix_vector_adapter_test\",\"schema\":\"vector_collections\"}"
export VECTOR_ADAPTER_TEST_ADMIN_URL="postgresql://postgres:adapter-test-admin@127.0.0.1:$port/vectorix_vector_adapter_test"
node --import tsx --test tests/adapter.test.ts
