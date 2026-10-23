#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Pure/injected checks only. A valid state never reaches a runtime entry point.
offline() { timeout 300s env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 PYTHONDONTWRITEBYTECODE=1 "$@"; }
offline python3 -B tests/acceptance/interruption/fault/fault_adapters_test.py
offline python3 -B tests/acceptance/interruption/observer/recovery_observer_test.py
(
    cd apps/api
    offline node --import tsx ../../tests/acceptance/interruption/fixture/fixture.test.mjs
    offline node --import tsx ../../tests/acceptance/interruption/fixture/preflight.mjs check
)

# Missing arguments must refuse before state reads, imports or resource I/O.
for entry in fault/fault_driver observer/recovery_observer; do
    set +e
    result="$(offline python3 -B "tests/acceptance/interruption/$entry.py" 2>&1)"
    status=$?
    set -e
    if [[ "$entry" == fault/* ]]; then
        expected='{"status": "REFUSED_OR_INCOMPLETE", "diagnostic": "FAULT_ARGUMENTS", "recoveryAcceptance": "NOT_OBSERVED"}'
    else
        expected='{"status": "REFUSED_OR_INCOMPLETE", "diagnostic": "OBSERVER_ARGUMENTS", "recoveryAcceptance": "NOT_ESTABLISHED"}'
    fi
    if [[ "$status" != 1 || "$result" != "$expected" ]]; then
        echo 'Interruption CLI refusal failed.' >&2
        exit 1
    fi
done
offline node tests/acceptance/interruption/validate-preparation.mjs
