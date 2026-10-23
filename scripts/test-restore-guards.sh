#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Pure file/mocked-resource checks only: no Docker, database, S3 or model calls.
python3 -B tests/acceptance/restore/m7c_restore_static_test.py
python3 -B tests/catalog/sql-function-restore-unit-test.py
node tests/acceptance/restore/m7c-object-manifest.test.mjs
