# Isolated capacity acceptance

This Linux operator harness prepares an owned native Ollama fixture, a measured 2,000-child pilot, a new 100,000-child generation and two bounded search/ingestion phases. It uses normal authentication, document, metadata, profile, index and source APIs. Guarded read-only observers independently check canonical layouts, physical publications, accounting, native observations and numeric resources. The original predeclared gates and measurement limits are in [the capacity guide](../../../docs/rag-capacity-acceptance.md). The shared runtime now supports exactly `DEFAULT_V1` and a [separate light experiment](../../../docs/rag-light-capacity-acceptance.md), with explicit immutable policy and collection-role bindings. Native execution of this new implementation remains NOT_RUN.

**Capacity and traffic acceptance remain NOT_RUN.** Neither historical pilot invocation completed. Run `6bfa16b98e99` stopped before its baseline journal with an unknown cause. Run `b53a06a45e8b` completed the reference/empty-collection baseline and confirmed four pilot uploads plus index admission, then stopped with `LOAD_CLOCK_NOT_ADVANCED`. Its formal result remains `INCOMPLETE/UNKNOWN`; it cannot admit a full run. A separate, guarded read-only observation later verified the accepted work's 2,000 children and 500 parents. That supplemental observation does not repair the invocation, prove its original deadline, supply complete pilot resource measurements or authorize full indexing. Both owned topologies were cleaned; private evidence remains ignored.

Before the first public delivery, eight reviewed timing files were subsequently corrected: four runtime files and their four tests. Local offline checks passed 200 tests plus one negative CLI check. That 60-source delivery is retained separately in provenance and has not had a default native retest. The new closed-policy implementation does not adopt those runs or their receipts. Historical success of the smaller [reference-quality run](../quality/README.md) is separate evidence, with no 100,000-child, load, ANN-recall or latency claim.

## Frozen inputs and boundaries

- `load-v1/` contains three unchanged default metadata files; `light-v1/` contains three separate light metadata files. Both are frozen local preparation, not native acceptance. The pilot is the exact first four documents of the 200-document full family: 500 searchable children and 125 derived parents per document. Full child texts and prepared inputs are distinct in each separately hashed family. The generated originals are not committed or seeded into a database.
- The reference corpus has one canonical location, [quality/reference-v1](../quality/reference-v1/manifest.json). Runtime manifests retain logical `reference-v1/...` keys, but resolve them to that sibling directory; there is no copied corpus or symlink here. Its immutable preparation records retain their historical `NOT_RUN` fields.
- The fixed native identity is Ollama `embeddinggemma:latest`, 768 dimensions, `EMBEDDING_GEMMA`, verified weights `85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`. Default token-window settings are 512/128/768/64 with parent maximum 2,048. LIGHT_V1 changes only A pilot/full to 128/32/192/16 with parent maximum 512; B and both ingestion controls retain the default profile. Metadata, preparation, index type and all resource limits remain frozen. A hosted fingerprint cannot substitute for these weights.
- Five new loopback-only containers own four new store volumes. The explicitly supplied existing model volume is mounted read-only and never deleted. Default application/vector names are exactly `vectorix_m7c_load_{app,vectors}_RUN_test`; light uses `vectorix_m7c_light_load_{app,vectors}_RUN_test`. Only the two exact descriptor-derived namespaces/paths are accepted; neither can adopt restore, quality, application or other-policy state.
- Durable work runs through the product workers. No helper inserts corpus business rows, vectors or task completion, rewrites deadlines, accelerates retention or silently retries an accepted mutation. Bootstrap alone creates the declared synthetic accounts/organizations and their narrowly scoped reader membership.

## Offline checks

Install the supported Node.js/pnpm versions and frozen workspace dependencies, then run:

```sh
pnpm test:capacity:guards
```

The explicit command runs mocked Python lifecycle/registry tests, Node pure/injected tests, local production geometry checks and an empty-argument bucket CLI refusal. It also verifies JavaScript/Python descriptor parity and default/light role/profile/admission behavior. It starts no service, worker thread, HTTP, PostgreSQL, Docker, S3 or model operation. Child environments exclude inherited configuration. The bucket negative must exit 1 with only `LOAD_BUCKET_ARGUMENTS` before private file reads or SDK construction. Enabled runtime entry points are tested with invalid inputs or injected refusal capabilities, never a valid live state.

The same command checks 72 current helper/test source hashes, three unchanged default metadata files, three separate light files, both descriptor hashes, 53 referenced canonical-quality files and the shared restore dependency. The [quality fixture validator](../quality/validate-preparation.mjs) separately covers its full 56-file inventory. Run-only reports, fixtures, passwords, cookies, receipts, database URLs and sample streams are never copied here.

## Fresh native workflow

Prerequisites are Linux with `/proc` and cgroup v2, Python 3.10+, Docker, already available pinned images, packaged production API/workers/web builds and an explicit plain local Ollama model volume. Run against a clean committed production tree. Build tools and services are not installed or started by the offline checks. The lifecycle reads no checkout `.env`, inherits no hosted credentials, pulls no images and pins exact current product, dependency, migration, build, helper, corpus, resource and model identities.

Run `pnpm build` first. Before `prepare` pins the complete build trees, include web standalone assets as the Dockerfile does:

```sh
cp -R apps/web/public apps/web/.next/standalone/apps/web/public
cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static
```

The preparer requires both directories; the CLI never copies assets or repairs an already pinned build. Use these copies on the fresh standalone output from the build.

```mermaid
flowchart LR
  Prepare[Fresh owned topology and pinned inputs] --> Baseline[Reference B and two empty ingestion collections]
  Baseline --> Pilot[Normal four-document pilot and observations]
  Pilot --> Gate[Measured admission gate]
  Gate --> Full[New full generation with 100000 children]
  Full --> Traffic[Paced then closed-loop search and tiny ingestion]
  Traffic --> Proof[Exact sources native counters resources and histogram evidence]
  Proof --> Cleanup[Owned cleanup and private evidence retained]
```

The commands below select DEFAULT_V1 by omission. For LIGHT_V1, pass `--experiment LIGHT_V1` on every Python command, including app, guard and cleanup; see the [complete light recipe](../../../docs/rag-light-capacity-acceptance.md). No environment variable selects a policy. Use a fresh identifier for every attempt:

```sh
capacity_run="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode prepare --model-volume YOUR_EXISTING_MODEL_VOLUME
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode deploy
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode verify-schema
```

Inspect `--help` for explicit local image choices. Deployment applies only the already approved migration chain to the fresh test database; it does not generate a migration or use `db:push`. Keep the API and workers in separate foreground terminals:

```sh
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode app --service api
```

From another terminal, seed before starting workers, then ready the fixture:

```sh
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode seed
```

```sh
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode app --service workers
```

```sh
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode ready
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode app --service load --workflow pilot
```

Only the original completed pilot report with its exact native, resource and size receipts can admit `--workflow full`; only the completed measured full report can admit `--workflow traffic`. Invoke those workflows through the same `app --service load` entry. History is once-only `pilot → full → traffic`. Keep unrelated dashboard/search traffic out of the observation cohort. A fresh deployment must use fresh pins; never alter old state to adopt relocated helpers or rerun an existing invocation.

Optional dashboard verification uses `app --service web` after the exclusive measured phases. Clean only the run's recorded resources:

```sh
python3 -B tests/acceptance/capacity/load-topology.py --run "$capacity_run" --mode cleanup
```

Private state and outputs live under `node_modules/.cache/vectorix/vectorix-m7c-load-RUN/` or the exact separate `vectorix-m7c-light-load-RUN/` directory. Cleanup checks exact container/volume creation identities and owned process PID/start/boot records. It preserves model storage and evidence; unknown identity refuses cleanup rather than deleting by name.

## Sources, proof and limitations

- `load-topology.py`, `load_topology_policy.py`, `load-bootstrap*.mjs`, `load-bucket.mjs`: exact owned lifecycle, isolated setup, scoped fixture and pinned 49-entry runtime closure, including the reused [restore common helper](../restore/m7c_restore_common.py).
- `load-corpus.mjs`, `load-import-{core,documents,collections,protocol}.mjs`, `load-transport.mjs`, `load-import-runtime*.mjs`: deterministic local sources, normal API actions, one fetch per RPC, exact native baseline, private one-shot journals and conservative accepted-mutation ambiguity. Timer wakeups complete the original interval without adding RPC retries or extending deadlines.
- `load-observer*.mjs`, `load-resources*.mjs`, `load-sizes*.mjs`: per-store read-only reconstruction and numeric resource/size evidence. Database sizes cover whole isolated stores and labeled relation scopes; physical volume bytes and model warmth remain UNKNOWN when not safely measured. Sample maxima are recorded points, not continuous peaks.
- `load-traffic*.mjs`: fixed paced/closed-loop offers, current provenance, exact source coverage, normal tiny ingestion, worker-thread resource sampling and asynchronous main-process guards. Valid empty search responses are HTTP successes; missing independently verified nonempty coverage for any organization/mode makes coverage INCONCLUSIVE. An unfiltered A request really uses `{}` filters. No ANN recall gate is inferred.
- SEARCH internal latency uses exclusive, exact observed hourly counter/histogram deltas, not invented per-request internal samples. Unknown gaps, restarts, other traffic, failed reconciliation or missing evidence refuse attribution. A strict histogram upper bound below one second can prove the bounded gate; it is not an exact p95 or a counterfactual speedup. Logical native batches do not count exact wire retries or billing.
- Ingestion retains recovered failure/supersession/retry history and its costs. Current READY/publication/layout/accounting work must drain by the original deadline. Consistent future retention cleanup can remain; unresolved FAILED cleanup with outstanding physical/ledger work prevents overall PASS. Historical stored task attempts are not lifetime or wire retry totals.

[Helper provenance](helper-provenance.json) preserves both actual 44-file native snapshots, the 44-entry post-timing/pre-relocation closure and the previous 60-source/44-runtime delivery. Schema 2 adds the current 72-source/49-runtime implementation, two exact descriptors and the separate light preparation. Current and historical source inventories remain distinct. Only the first two inventories were archived for the failed native attempts; an archived file is not proof that it executed. The post-timing and relocated files do not retroactively belong to those runs. Three default and three light metadata files and 53 canonical-quality references are pinned separately. The hardcoded supplemental observer is excluded as a reusable command; only its archive hashes are recorded. This manifest is a consistency record, not a signature, successful benchmark or independent runtime attestation.
