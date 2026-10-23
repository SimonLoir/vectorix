# Isolated full-store restore acceptance

Status: guarded tooling reviewed; actual source/export acceptance completed, but the first full-store restore exposed a SQL function lookup defect. [The forward migration](../../../docs/rag-sql-function-restore.md) was independently reviewed, explicitly authorized and generated. Disposable SQL/path/concurrency checks, the populated application-database archive regression and the full catalog pass: 11 migrations across fresh/upgrade/repeat/parity checks and 238/238 API journeys. The corrected full-store restore, dashboard sign-in/search/source checks, fresh-Redis replay, rebuild and natural cleanup pass on the owned fixture; exact infrastructure teardown is complete. The earlier failed run's infrastructure was cleaned; its private bundle is preserved and must not be enabled or relabeled as the corrected baseline. The actual outcome belongs in [the restore acceptance record](../../../docs/rag-restore-acceptance.md) and [the build log](../../../docs/build-task-log.md).

This Linux-only acceptance workflow uses the production application builds, normal authenticated document/index/search operations and a deliberately small synthetic workspace. It owns separate source and target PostgreSQL, vector PostgreSQL, Redis and RustFS volumes. An explicitly supplied, already populated Ollama model volume is mounted read-only and is never deleted. It does not read the checkout `.env`, discover cloud credentials, contact a hosted embedding provider or operate on an existing application database.

This is an operator acceptance tool for its own fixture. It does not accept an arbitrary customer backup, implement a production backup scheduler, preserve arbitrary cloud bucket policies or rebind a collection to a different vector database identity. The private unencrypted bundle includes sensitive test configuration and must remain outside Git and PR attachments.

## Prerequisites

- Linux with `/proc`, **Python 3.10+**, Docker and the repository's supported Node.js/pnpm versions; installed frozen workspace dependencies and completed production builds for web, admin, API and workers. The Python helpers use the standard library only.
- At least 4 GiB free on the cache filesystem for this bounded exercise. This threshold is a refusal guard, not a production sizing recommendation.
- Free local application ports 3100 (web), 3101 (API) and 3006 (admin). Infrastructure ports are allocated on loopback and recorded privately.
- The locally available images explicitly selected at preparation. The helper pins their immutable image IDs and uses `--pull=never`; it does not silently fetch or update images.
- An explicit existing plain local Docker volume containing the required Ollama model. See [the first-search guide](../../../docs/rag-first-search.md) for the separate model setup. Model availability and actual verified weight identity must be established during the dashboard journey.

All application/vector database names end in `_test`. Each run uses a fresh twelve-character lowercase hexadecimal identifier, exact resource labels and a private `node_modules/.cache/vectorix/vectorix-m7c-restore-RUN/` directory. Keep the run state until all owned containers and volumes have been cleaned; cleanup requires those ownership records. Never replace their identifiers to adopt another resource.

## Explicit commands

The reviewed CLI is `python3 -B tests/acceptance/restore/m7c-restore.py`. Preparation drafts deliberately refuse execution until their review is complete. First run the independent pure guards:

```sh
pnpm test:restore:guards
```

The pure command currently passes 42 checks: 23 shared Python guard/archive tests, five catalog-restore ownership/refusal tests and 14 object-manifest tests. It does not connect to Docker, PostgreSQL, S3 or a model. The separate [catalog restore regression](../../catalog/sql-function-restore-check.py), [populated seed](../../catalog/sql-function-restore-seed.sql), [function upgrade check](../../catalog/sql-function-upgrade-check.sql) and [empty-path/shadow probes](../../catalog/sql-function-path-check.sql) are wired into `pnpm test:catalog`. They verify the ordinary application-database archive path, not full-store browser acceptance.

Choose a fresh run and supply the existing model volume explicitly:

```sh
restore_run="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode prepare-source --model-volume YOUR_EXISTING_MODEL_VOLUME
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode deploy-approved-source-schema
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode source-ready
```

Preparation accepts explicit `--postgres-image`, `--vector-image`, `--redis-image`, `--rustfs-image` and `--ollama-image` references/IDs, which must already exist locally. Inspect `--help` for the defaults. This exercise uses pinned image identities across both source and target; changing an image during restoration is a different compatibility experiment.

Start each app in a separate foreground terminal, one at a time. Substitute `web`, `admin` and `workers` for `api` as needed. Start the API before running `--mode seed`; the seed creates only this new fixture's accounts, organizations and initial storage/group configuration. Its private `fixture.json` contains synthetic login credentials and must not be printed or committed.

```sh
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode app --side source --service api
```

After completing the source dashboard sequence, the explicit cutover modes are:

```sh
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode pause-workers
# Queue the fully uploaded replacement and separate indexing action in the dashboard.
# Stop browser activity before continuing.
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode capture
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode stop-source
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode create-target
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode restore
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode verify-target
```

Before capture, update only the private fixture's `documentIds` and `collectionIds` arrays with the exact identifiers from the dashboard detail URLs. Keep its seeded run, user and organization fields unchanged. The exercised recipe has four document IDs and three collection IDs; replacement adds a version to the same Markdown document ID. Optional local name-to-ID notes are not product state. Never print the fixture, invent identifiers, seed business rows directly or edit this file after capture: its complete bytes are pinned by the bundle and verified again on restore.

Use `--mode app --side target --service SERVICE` for each restored service, initially keeping workers stopped. `--mode status` prints a safe phase/resource summary. A failed phase does not establish successful backup or restore. Do not bypass a refusal by changing the state or artifact hashes.

A failed pre-export proof can resume with `--mode capture` only while no bundle directory exists; the helper repeats the stopped-writer and stable-snapshot checks. Existing or partial bundles are never overwritten. Use `--mode quarantine-incomplete-capture` only for an incomplete, owned export after investigating its failure; it preserves the partial bytes separately and repeats all source proofs on the next capture. It refuses a complete manifest. A partial target restore remains quarantined; after inspecting the failure, clean only the target side, then use `--mode create-target` to recreate it if the original verified bundle and stopped source resources still exist. No database repair or manual phase editing is required or supported. A product schema defect needs a reviewed forward migration and a newly captured baseline, not edits to the old bundle or pins.

After recording the actual restored dashboard/replay/rebuild/cleanup evidence, stop and remove the exact owned resources:

```sh
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode cleanup --side target
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode cleanup --side source
python3 -B tests/acceptance/restore/m7c-restore.py --run "$restore_run" --mode cleanup-model
```

Cleanup retains the private bundle and state for diagnosis and never removes the supplied model volume. Any later local artifact removal must target only this run after evidence has been recorded. A failed graceful shutdown or unknown resource identity requires investigation; the helper does not force-kill an unrelated process or clean a database by name alone.

## Schema comparison rules

The [shared archive helper](m7c_restore_archive.py) compares full schema dumps with one narrow PostgreSQL 18 deparser allowance: one redundant AND-grouping parenthesis pair in each of `EmbeddingWorkAttempt_bounds_check`, `OrganizationQuota_semantic_limits_check` and `SemanticChunkPlan_bounds_check`. The exact fragments cover operation key lengths from 1 to 128, semantic unit counts from 1 to 8,192 and nullable checkpoint-vector byte lengths from 4 to 64,000. They apply only in the reviewed `public` table/constraint contexts; all bounds, operators and other SQL remain significant. In the populated regression, this CHECK allowance removes six source parentheses and no target parentheses.

Balanced, matching PostgreSQL random `\restrict`/`\unrestrict` key lines are also omitted; `\connect`, function bodies, literals, comments and other schema bytes remain. This is not general SQL/whitespace normalization or an archive repair. Unknown or changed expressions still fail the schema proof. [The detailed normalization basis](../../../docs/rag-sql-function-restore.md#exact-schema-comparison-normalization) and [pure mutation regressions](m7c_restore_static_test.py) document these exact exceptions. Source and target retain the same immutable PostgreSQL image, and the ordinary restore still validates all row data and constraints.

## Acceptance sequence

1. Prepare a fresh owned source environment and explicitly deploy only the existing approved migration chain. Verify its checksums before starting applications. Migration generation and target migration are outside this workflow.
2. Start foreground production services separately and sequentially. Create the synthetic accounts/organizations, then use the dashboard for the fixture upload, profiles, permissions, indexing, search and exact-source downloads. The seed helper's direct membership/admin writes are fixture setup only, not proof of a product journey.
3. Keep organization A's saved organization S3 credential and B's platform fallback distinct. Record the real document/collection identifiers in the private fixture state. Both saved binding branches must be present before export is allowed.
4. Gracefully stop only the owned worker. Through the dashboard, fully accept Markdown version 2 and a separate pending indexing action while version 1 is still serving. Stop browser activity, then stop API/web/admin. Do not issue source requests during the quiescent barrier: they can renew holds.
5. Capture stable database manifests before and after the bounded dumps/object export. Any in-flight work, unknown resource, object outside the fixture, unsupported object policy, output cap or changing manifest aborts the clean-baseline exercise.
6. Stop the source containers, preserving their volumes. Create distinct target volumes at the exact same logical ports and database names. Restore the original roles, database/schema/data and private object set, retaining vector identity, S3 destinations and protected runtime secrets.
7. Before starting writers, require exact schema/row/role/extension/vector/object manifests and a genuinely empty fresh Redis. Checksums establish consistency with this trusted local fixture; they are not encryption, signatures or an authenticity guarantee.
8. Start target API/web/admin with workers stopped. Sign in through the restored dashboard, verify grants/isolation, the old serving sources and actual vector/hybrid search. Then start the worker and verify ordinary PostgreSQL task replay.
9. Launch a normal dashboard rebuild, observe its actual cutover, then exercise deletion with the chosen normal retention. Wait real retirement/source-hold deadlines and prove physical cleanup; do not edit clocks, leases, task completions, fingerprints or quota counters.
10. Save only safe counts, hashes, timestamps and screenshots as acceptance evidence. Clean both exact owned infrastructure sides and the owned model container, close created browser tabs, and preserve the pre-existing model volume and user resources.

The small [fixture originals](fixtures/README.md) cover persistence and replay. They do not establish relevance, throughput, 100,000-child capacity or internal search p95 targets. Those remain separate M7c acceptance work.
