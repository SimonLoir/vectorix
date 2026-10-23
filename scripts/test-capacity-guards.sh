#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Explicit injected/pure checks only. No runtime command receives a valid state or run.
offline() { timeout 300s env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$@"; }
offline python3 -B tests/acceptance/capacity/load-topology.test.py
for test in load-bootstrap load-bucket load-private load-transport load-observer-import load-resources load-sizes load-traffic load-traffic-runtime load-traffic-adapters; do
    offline node "tests/acceptance/capacity/$test.test.mjs"
done
(
    cd apps/api
    for test in load-corpus load-import load-import-runtime load-observer load-traffic-ingestion-observer; do
        offline node --import tsx "../../tests/acceptance/capacity/$test.test.mjs"
    done
)
# Empty CLI arguments must refuse before filesystem/client/resource work, including when enabled.
set +e
result="$(offline node tests/acceptance/capacity/load-bucket.mjs 2>&1)"
status=$?
set -e
if [[ "$status" != 1 || "$result" != '{"completed":false,"diagnostic":"LOAD_BUCKET_ARGUMENTS"}' ]]; then
    echo 'Capacity bucket CLI refusal failed.' >&2
    exit 1
fi
offline node tests/acceptance/capacity/validate-preparation.mjs
