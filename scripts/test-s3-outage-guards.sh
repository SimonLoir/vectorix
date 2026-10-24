#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Pure/injected checks only; no admitted live topology is supplied to these tests.
offline() { timeout 300s env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$@"; }
offline python3 -B tests/acceptance/s3-outage/lifecycle_test.py
offline python3 -B tests/acceptance/s3-outage/fault_test.py
offline python3 -B tests/acceptance/redis-outage/redis_test.py
offline node --test tests/acceptance/s3-outage/observe.test.mjs tests/acceptance/s3-outage/objects.test.mjs tests/acceptance/s3-outage/cleanup.test.mjs tests/acceptance/redis-outage/pending.test.mjs tests/acceptance/redis-outage/transfers.test.mjs tests/acceptance/s3-outage/vector.test.mjs

for entry in private seed bucket smtp observe objects cleanup-fixture cleanup-observe vector-embedding vector-curl vector-workflow vector-observation vector-snapshot vector-observe; do
    offline node --check "tests/acceptance/s3-outage/$entry.mjs"
done

for entry in pending pending.test curl key-policy transfers transfers.test; do
    offline node --check "tests/acceptance/redis-outage/$entry.mjs"
done
