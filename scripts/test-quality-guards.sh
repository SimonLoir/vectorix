#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Frozen fixtures and injected adapters only: no HTTP, database, Docker or model.
python3 -B tests/acceptance/quality/quality-topology.test.py
python3 -B tests/acceptance/quality/quality-collector-outcome.test.py
node tests/acceptance/quality/quality-bootstrap.test.mjs
node tests/acceptance/quality/quality-bucket.test.mjs
node tests/acceptance/quality/collector-protocol.test.mjs
node tests/acceptance/quality/evaluate.test.mjs
