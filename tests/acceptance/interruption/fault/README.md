# Focused semantic boundary fault driver

These entry points perform explicit operator actions only. Importing them starts no process, resource or request. They reuse the tracked [quality topology](../../quality/README.md), its exact ownership/build/schema/source checks and a fresh synthetic fixture. They do not modify that lifecycle or grant content access. Read the [operator sequence](../README.md) and [actual acceptance record](../../../../docs/rag-interruption-acceptance.md) before using them.

The native sources used by run `8af698331852` remain privately archived. These portable paths are separately hashed and **have not had a native retest**. Historical observation, the timestamp correction and relocalized sources are not interchangeable evidence.

## Enrollment and actions

`fault_driver.py` accepts only `enroll`, `crash`, `absent` and its child-only `watchdog` mode. A new run must be enrolled after normal quality bootstrap, before any document or collection. The existing dashboard guard requires exact owned live API/workers and dependencies. Actual global document/collection counts must both be zero. Enrollment creates one private `m7c-interruption-RUN/` directory and binds both fault source hashes plus immutable product/build/resource identities. Existing enrollment refuses replay.

Normal dashboard operations then create one artificial document and one semantic collection, serve generation A and admit B with a different percentile. The fault requires a real nonempty accepted prefix with work remaining, 65–256 canonical units, the exact source/profile/model bindings and one matching live BOUNDARY dispatch. `caught.completedUnits` supplies the actual prefix; 32 is an expectation, not an assigned value.

The crash caller must run from the repository root using the **absolute** script path in its command line. Its initial environment may contain only PATH, LANG, LC_ALL, TMPDIR and exact `VECTORIX_FAULT_RUN` / `VECTORIX_FAULT_ROLE=driver` markers. The original quality lifecycle lock prevents competing lifecycle actions. The driver validates the saved exact worker PID, start ticks, boot ID, owner, cwd, command, environment and entry hash, then signals a pidfd rather than a reusable numeric PID.

Before pausing the exact owned model container, a separate watchdog process outside the driver session must acknowledge its private control. Container ID/image/labels/resource limits/mount/volume identity are checked. The 100-second monotonic pause budget reserves 55 seconds for bounded inspections/unpause. An unavailable control plane is never a guaranteed hard bound or confirmed resume. Both the driver finally path and watchdog inspect/resume idempotently, including an ambiguous accepted pause and a stale ARMED read followed by driver death. No other container/service/volume is a fault target. The existing model volume remains read-only and preserved.

The one-shot result records only the action outcome. `WORKER_KILLED_MODEL_RESUMED` does **not** establish recovery; `recoveryAcceptance` remains `NOT_OBSERVED`. A missed checkpoint, changed identity, failed signal, unconfirmed resume or exhausted deadline is INCOMPLETE. No task, lease, deadline, quota, publication or application clock is rewritten. The driver never starts/restarts workers or retries accepted work.

## Observation and ordinary restart

The separate `admit_absent()` capability requires a completed crash/resume result, the exact original saved worker still absent, current live owned API/dependencies, unchanged identities and the original 15-minute trial deadline. It is read-only and does not bypass session/current ACL checks for dashboard requests. The ordinary quality guard continues requiring live API/workers and is used again after a normal recorded worker restart.

Wait the actual persisted task/native deadlines before restart; no artificial expiry is supported. The [observer](../observer/README.md) records logical prefix/history/accounting evidence; [physical reconciliation](../physical-proof.md), native evidence and dashboard/source checks remain separate.

## Offline tests

```sh
python3 -B tests/acceptance/interruption/fault/fault_adapters_test.py
```

Tests inject resource/process/SQL/signal boundaries and use only owned local temporary files. They cover fresh enrollment, exact absence, bounded current dispatch/epoch checks, pidfd ordering, finally cleanup, the stale-ARMED watchdog race and finite argument diagnostics. Dedicated disabled tests patch the flag True. Enabled entry points receive invalid arguments and must refuse before source/state/resource access. Running tests never exercises a valid live command or changes historical source flags.
