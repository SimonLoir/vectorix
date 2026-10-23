# Isolated semantic interruption acceptance

These Linux operator helpers cover one worker termination during an accepted semantic-boundary plan. They reuse the exact owned [quality topology](../quality/README.md) without weakening its normal worker guard. A separate fault enrollment and absence admission bind the fresh empty run and exact process/container identities. The product receives normal dashboard actions; the helpers never insert document/vector business rows, complete tasks, change clocks/deadlines or force retention.

The [actual acceptance guide](../../../docs/rag-interruption-acceptance.md) reports one recovered native trial separately from its original **INCOMPLETE** formal observer. Its supplemental catalog, physical and dashboard observations are preserved. This relocated/corrected harness has **NATIVE_RETEST_NOT_RUN** status. A checksum inventory is source provenance, not proof that a file executed or that a benchmark passed.

## Offline checks

```sh
pnpm test:interruption:guards
```

The command runs pure/injected Python fault and recovery tests, local production fixture planning/preparation checks, invalid CLI refusals and the source inventory validator. It starts no application, container, database, provider or network operation. Invalid CLI inputs fail before private-state access. Runtime helpers are enabled for deliberate manual operation; tests inject refused capabilities or supply invalid arguments.

- [fault](fault/README.md): one-shot enrollment, exact worker pidfd signal, bounded owned model pause and independent unpause watchdog. Import performs no resource inspection.
- [observer](observer/README.md): once-only, bounded, read-only application checkpoints before expiry, after expiry and after recovery. A corrected parser requires actual UTC/type provenance for designated offset-free Prisma dates. Retained children are classified by the retired generation.
- [fixture](fixture/README.md): deterministic artificial TXT, production extraction/unitization/preparation and frozen public inputs. Synthetic geometry does not predict native distances.
- [physical proof](physical-proof.md): separate application/vector/application equality and exact child-tuple reconciliation, with validated generated identifiers and finite bounds. This recipe is not called by the checkpoint observer.
- [provenance](helper-provenance.json): historical enabled sources, later corrected/relocated sources and frozen inputs. Private run state, passwords, URLs, cookies, checkpoints, receipts and screenshots are excluded.

## Fresh native workflow

Use Linux with `/proc`, cgroup v2 and pidfd support, Python 3.10+, the supported Node/pnpm versions, Docker, the already available pinned images and an explicitly selected existing Ollama model volume. Build the production API/workers/web from a clean committed product tree and copy web public/static assets into its fresh standalone output as described in the [quality workflow](../quality/README.md). Do not repair an already pinned build, reuse archived state or adopt relocated sources into an existing run. No helper reads the checkout `.env`, pulls images or inherits hosted credentials.

Prepare a fresh quality topology, deploy only the approved migrations to its `_test` databases, verify schema, start the production API, seed synthetic accounts, start workers and mark ready using that workflow. **Do not run the quality collector.** Before uploading anything, enroll the empty run once:

```sh
python3 -B tests/acceptance/interruption/fault/fault_driver.py --run "$interruption_run" --mode enroll
```

Compile the observer's fixed SELECT and the two physical templates against the admitted empty schema before content. Inspect actual UTC session/type metadata. This is a read-only compilation check, not acceptance. The fresh trial must use the corrected sources and a newly pinned observer manifest; old incomplete invocations are never replayed.

Start the owned web process through `quality-topology.py --mode app --service web`. Use the synthetic owner and the [dashboard recipe](../../../docs/rag-interruption-acceptance.md): exact fixture filename, native provider probe, one document, one collection, A at percentile 90 and B at 55. Keep model/preset/dimensions, source, metadata and all other profile fields unchanged. Verify A's exact physical publication before requesting B.

Capture the organization, collection, document and A/B generation identifiers from the admitted run, using local shell variables. After the dashboard reports an accepted nonempty partial B boundary prefix, run the fault **once** from the repository root. Its process entry must be absolute and its initial environment minimal; the adapter rejects unrelated inherited variables:

```sh
env -i PATH="$PATH" LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  VECTORIX_FAULT_RUN="$interruption_run" VECTORIX_FAULT_ROLE=driver \
  python3 -B "$PWD/tests/acceptance/interruption/fault/fault_driver.py" \
  --run "$interruption_run" --mode crash \
  --organization "$interruption_org" --collection "$interruption_collection" \
  --document "$interruption_document" --generation "$interruption_b"
```

The adapter requires a real accepted partial plan and live in-flight boundary dispatch. Missing that window refuses the trial; never shorten the source or alter a deadline in the same run. Before any restart, require confirmed model resume, old worker absence and a serving A. Run the first observer stage once:

```sh
python3 -B tests/acceptance/interruption/observer/recovery_observer.py \
  --run "$interruption_run" --stage absent-checkpoint \
  --organization "$interruption_org" --collection "$interruption_collection" \
  --document "$interruption_document" --old-generation "$interruption_a" --generation "$interruption_b"
```

While absent, verify actual A search/exact source from the dashboard. Wait until both original task/work deadlines have passed according to the database, then use the same observer command with `--stage expired-before-restart`. A failed stage stays incomplete; do not replay its invocation or synthesize a previous proof. Start the normal worker through the original topology entry point, wait for B activation, and run the observer with `--stage recovered` within the original 15-minute trial window.

Finish the separate physical recipe, B search/parent context, a fresh previously unopened page of retained A's exact source, Index, Usage, Operations and console checks. Record actual locales, uncertainty, reservations and legitimate future cleanup. Logical dispatch counts cannot establish exactly-once native execution or billing. Then use `quality-topology.py --run "$interruption_run" --mode cleanup`; close only created browser tabs. Cleanup preserves private evidence and the explicitly supplied model cache.

## Integration boundaries

`fault/fault_admission.py` loads the tracked quality primitives and binds immutable topology identities. Its absence admission is scoped to this enrolled scenario; normal `quality-topology.py` checks remain unchanged. `fault/fault_driver.py` owns the pre-acknowledged watchdog and one signal. `observer/recovery_observation.py` owns fixed SQL, finite projections and pure assertions; `observer/recovery_observer.py` owns source verification, once-only journals and stage ordering. Fixture preflight calls actual source modules in `packages/documents`, the worker plain-text extraction service, `packages/chunking` and `packages/embeddings`.

No dependency outage, other worker stage, hosted provider, capacity, ANN recall, latency threshold or long retention soak is established by this one case. The [implementation plan](../../../docs/rag-implementation-plan.md) keeps those acceptance gaps explicit.
