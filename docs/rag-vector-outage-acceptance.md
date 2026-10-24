# Vector PostgreSQL provisioning outage — disabled acceptance foundation

**Status: the third trial is INCOMPLETE during outage observation; native G1 READY, G2 staging and outage curl checks passed separately. Dashboard retry/recovery remain NOT_RUN.** `VECTOR_PROVISION_V1` accepts G2 while G1 is active, makes only the owned vector PostgreSQL unavailable during G2's durable PROVISION task, then intends to restore that same store and retry the same task. It changes no production behavior, schema, migration, permission, public DTO or API revision. All three trials have been cleaned and their enabled sources restored exactly. The current primed-observer correction is disabled and offline-tested only; no replacement run is selected.

The dependency is the reviewed disabled protocol-2 S3/cleanup harness at `79bd189`, integrated as a local ancestor with actual main `c93e30c7`. Its historical source inventories and native results remain unchanged. The vector delta adds a third explicit scenario in namespace `vectorix-m7c-vector-provision-<12hex>`. States, databases and receipts from another scenario are refused; this is not a replay of ingestion, cleanup, capacity or Redis evidence. The cleanup and Redis delivery dependencies have reached actual main. This checkout deliberately retains its tested `dc314fcfe02bbc30877bb1a4a1720d1bb3abccde` product/build pins until a later reviewed alignment; newer main commits are not attributed to these trials.

## Exact journey and evidence boundaries

1. Create four new owned PostgreSQL/vector/Redis/RustFS stores and volumes with exact `_test` databases. Launch API, web, workers, bounded SMTP and one synthetic embedding process, all on recorded loopback bindings. Admin is build-pinned but not launched. Source/build/helper/migration/runtime/curl pins precede preparation; no `.env`, application database, hosted key, model volume or GPU is used.
2. An ordinary native HTTP account/organization seed signs out. Session curl creates one collection from the fixed platform-fallback profile, uploads the pinned TXT bytes, waits for native extraction READY, attaches it and starts G1. Native read-only polling requires G1 ACTIVE before the setup receipt is published. No organization credential, API key, role, group or explicit grant is created by the recipe. The collection's normal creator grants remain native behavior.
3. Inspect the existing dashboard index/search controls using normal login. Curl verifies G1 LEXICAL/VECTOR/HYBRID results, the observed publication, exact child/parent ranges, source preview and original bytes. **All upload/download transfers use curl; the browser never transfers files or deletes content.** The positive read path uses the existing owner session, not an API-key authorization claim.
4. Emit the one-shot `vector-g1-ready` proof immediately before enrolling the independent watchdog. After its ACK, pause only the exact worker through pidfd. Session curl accepts G2 using the unchanged saved revision and expected G1 ID while the vector destination is still online. `vector-g2-staged` requires G1 ACTIVE, G2 PROVISIONING, an unclaimed PENDING/attempt-0 PROVISION task, zero live claims, and no G2 physical generation/table.
5. Start the outage observer while the worker is still paused. It initializes the production planner and both readers, validates the unclaimed staged application/physical state and closes its vector reader before atomically publishing `vector-observer-ready.json`. Only this immutable, fresh, source/proof/PID-bound ACK permits the fault command. Require at least 625 seconds remain in the original 900-second window immediately before stopping the exact owned vector container, then resume the same worker. Only that container is stopped; the application database, Redis, RustFS, API, fixture and web remain available. DB-only polling observes five failed provision claims and all natural **10/20/40/80-second** indexing backoffs, totaling at least 150 seconds plus actual I/O/scans. This differs from S3 cleanup's 20/40/80/160-second schedule. Attempts and monotone lease epochs are recorded, never changed. Terminal task state is FAILED/VECTOR_UNAVAILABLE with cleared lease; the generation can remain PROVISIONING.
6. During the outage, G1 remains the active catalog pointer. LEXICAL search and S3 source reads can still work. A real HYBRID request must return the typed VECTOR_UNAVAILABLE refusal; it must not silently degrade to lexical results. No vector physical query or vector-readability claim is made while the store is stopped.
7. Restore the same vector container and volume, preserving the database identity and saved destination fingerprint. `vector-restored-before-retry` confirms G1's sealed physical manifest and G2's continued absence. Use the actual dashboard **Retry task** control once. Native retry resets the same accepted task and fences its epoch; the worker provisions, embeds and activates G2 automatically.
8. Require G2 ACTIVE, G1 RETIRED, exact sealed physical manifests and canonical app layouts, correct source holds and active/retained/reserved accounting. Curl verifies all three search modes against G2 and exact original/preview bytes. The exact inventory is two cost tasks for G1, four before G2 activation, then those four plus one unclaimed PENDING/ACCEPTED G1 CLEAN_GENERATION task. Its schedule equals G1.cleanupAfter and the retained hold deadline; G1.retiredAt equals G2.activatedAt and the deadline uses the pinned production source-retirement constant (currently 17 minutes). No clock advance, row rewrite or forced cleanup is allowed. Normal logout precedes the final signed-out proof and exact owned-resource cleanup.

```mermaid
sequenceDiagram
    participant C as Native session curl
    participant UI as Dashboard
    participant F as Fault controller and watchdog
    participant DB as Application database
    participant O as Primed observer
    participant W as Same worker
    participant V as Same vector PostgreSQL
    C->>DB: Upload, attach and publish G1
    UI->>DB: Inspect active G1
    F->>W: Pause after original watchdog ACK
    C->>DB: Accept G2 while vector store is online
    O->>DB: Validate unclaimed staged state while worker paused
    O-->>F: Atomic source and PID bound ready ACK
    F->>V: Stop exact container with original budget remaining
    F->>W: Resume same worker
    loop Five natural provision claims
        W->>V: Attempt destination admission
        W->>DB: Record unavailable and natural backoff
    end
    Note over DB: G1 stays active while G2 remains unpublished
    F->>V: Start same container and volume
    UI->>DB: Retry same failed task explicitly
    W->>V: Provision and seal G2
    W->>DB: Publish G2 and retire G1 atomically
    C->>DB: Search and verify exact sources
```

This scenario targets an unavailable destination during the **PROVISION task**, which can fail in destination initialization before provisioning DDL is attempted. It does not establish interruption inside DDL, a partial vector batch, sealing, or the interval between vector seal and catalog commit. Existing [native adapter tests](../packages/vector-store/tests/adapter.test.ts) cover epoch fencing, partial manifests, immutable sealing and physical index shape. The [post-seal worker regression](../apps/api/src/rag-tests/index-worker.ts) reconstructs catalog state in CI; it is not native outage evidence. A write-boundary scenario would need a separately reviewed bounded embedding-response barrier and is outside this foundation.

## Components and limits

`lifecycle.py`, `private.mjs`, `seed.mjs`, `bucket.mjs`, `smtp.mjs` and `fault.py` reuse the existing protocol-2 ownership, pinning, private files, pidfd and cleanup primitives. Seed close-before-success and the guard-timeout hook reuse the reviewed Redis changes. The new focused files are:

- `vector-embedding.mjs`: synthetic Ollama `/api/tags`, `/api/show` and `/api/embed` only; fixed model, three deterministic nonzero dimensions, 16 inputs/16 KiB request, four active requests, 16 concurrent sockets, 128 total connections, 128 admitted requests and a 45-minute process lifetime. It has no outbound I/O and receives no database/SMTP/provider secret environment. Five-second HTTP bounds remain subject to fail-closed guard work. Numeric counters contain no input text or raw mail.
- `vector-curl.mjs`: the reviewed private-file curl transport with a closed route set. Binary pin, no `.curlrc`, proxy, redirect or automatic retry; two-second connect, at most 15 seconds/call, 16 KiB request and 64 KiB response body. Secret headers/bodies stay in exclusive 0600 files and are removed after each child. Its binary hash does not attest all shared OS libraries.
- `vector-workflow.mjs`: one-shot `prepare-g1`, `rebuild-g2`, `search-g1`, `search-outage` and `search-g2` modes. At most 80 ordinary HTTP calls within 180 seconds; sign-out retains one separate ten-second cleanup attempt. Source and index readiness each have at most 30 read-only polls. Unknown mutation acceptance is not retried. Completed receipts require confirmed sign-out and final guard checks.
- `vector-observation.mjs`: pure fixed-profile, G1/G2 pointer, layout, source-hold, accounting and natural-backoff validation.
- `vector-snapshot.mjs`: bounded READ ONLY application/physical readers. Two generations, two candidates, at most five tasks, 32 app rows and eight child vectors per generation; JSON spans are sliced to 64 inside SQL. Physical manifests expose IDs/hashes/counts, never raw vectors. Vector identity is hashed in evidence.
- `vector-observe.mjs`: six exclusive phase proofs, at most 360 two-second outage snapshots/11 changed task states, sharing the original watchdog deadline and a 720-second maximum. Online phases have a 120-second acceptance deadline. Each physical query requires positive remaining budget immediately before dispatch and a client query timeout bounded by that budget; rollback and reader closure are still drained after refusal. App metadata is reread after physical I/O; this is not an atomic cross-store snapshot. Both readers must close successfully and the resource/watchdog/ACK/reference guard must pass before an OBSERVED proof or completed stdout is written.

Every later phase binds G1's publication, ordered child manifest and destination fingerprint to the initial READY proof; online phases also compare its sealed physical receipt and database identity. Coherently changed application and physical metadata cannot replace that baseline. G2 retains the same PROVISION task ID from its staged proof through final sign-out. Its epoch must advance across failed claims and explicit retry, remain unchanged between failure and restoration, and remain unchanged from completion through sign-out.

The vector-only `vector-outage-watch` guard admits only UP/paused before an exact fault intent, then the monotone UP/paused → DOWN/paused → DOWN/running transition; skipped intermediate samples are allowed, backwards transitions and UP/running are refused. Existing normal staged/outage guards are unchanged. The guard samples the worker before its final store read to avoid combining an earlier UP sample with a later resumed worker. Before the first await, an atomic intent records the observer identity for cleanup. Its ready ACK binds run/scenario/phase, selected source commit and helper hashes, staged-proof hash, original watchdog hash/deadline, exact worker/store and observer PID/start ticks/boot/cwd/command hash. Fault admission requires that same live, non-stopped observer and a maximum 90-second ACK age before intent, immediately before stop and immediately before resume. After admission, the immutable ACK remains pinned without expiring during the natural backoffs. No rearming is possible.

The already initialized application reader polls before, during and after the source-bound fault intent; there is no cold import or new database connection after worker resume. Pre-fault waiting is bounded by 90 seconds, the existing 360-snapshot/720-second limit includes waiting and the original 900-second watchdog remains authoritative. The new guard child is capped at 15 seconds and the application READ ONLY transaction at 15 seconds. Cleanup identity-checks and drains the observer with pidfd/SIGTERM before removing stores, with a 55-second refusal timeout and no SIGKILL. Cancellation, intervention, failed close or final guard refusal prevents a success proof.

On failure, evidence retains only eleven validated eight-field durable schedule rows plus a separate validated twelfth overflow event if present, never a full task, raw lease token, source text or native error. `COLLECT_BOUND` identifies collector overflow; `INCOMPLETE_TRACE` identifies fewer than five schedules at validation. Both retain the original requirements for five claims and four natural delays.

The original watchdog window includes pause, native G2 admission, outage, natural retries and restoration. It is never refreshed. A late refusal restores only enrolled identities and remains INCOMPLETE; any watchdog intervention permanently prevents PASS. Cleanup resumes a paused identity-matching worker before graceful shutdown and removes only recorded stores/volumes/processes, without SIGKILL. SMTP retains its existing bounded synthetic capture; zero mail is not assumed.

The model name/digest and vectors are **synthetic protocol fixtures**. A saved native Ollama-shaped capability snapshot is not an attestation of actual model weights. This exercise measures neither Gemma, hosted-provider quality, usage billing, latency, fairness nor capacity. Existing frozen reference/capacity corpora and evidence remain untouched.

## Disabled commands and future native review

All 13 current I/O gates remain true. The vector recipe would require a reviewed activation of exactly nine: lifecycle, fault, seed, bucket, SMTP and the four new entry/transport gates. The unrelated ingestion/object and cleanup entries stay disabled. Do not enable anything from this guide alone. The operator must select a fresh 12-hex run and review current source/build/helper pins first; no run is selected here.

After that separate approval, these are the closed command shapes from the repository root (foreground apps and watchdog use separate owned terminals):

```sh
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode prepare
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode deploy-existing-migrations
# Deployment already initializes the private bucket: do not invoke bucket again.
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode app-smtp
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode app-embedding
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode app-api
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode seed
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode app-workers
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode app-web
node tests/acceptance/s3-outage/vector-workflow.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode prepare-g1
node tests/acceptance/s3-outage/vector-workflow.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode search-g1
node tests/acceptance/s3-outage/vector-observe.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --phase vector-g1-ready
python3 tests/acceptance/s3-outage/fault.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode watchdog
python3 tests/acceptance/s3-outage/fault.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode pause-worker --fixture-ready
node tests/acceptance/s3-outage/vector-workflow.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode rebuild-g2
node tests/acceptance/s3-outage/vector-observe.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --phase vector-g2-staged
# Start the primed observer in a separate owned terminal while the worker is still paused.
node tests/acceptance/s3-outage/vector-observe.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --phase vector-outage-failed
# Wait for its complete atomic vector-observer-ready.json ACK; never replay or refresh it.
python3 tests/acceptance/s3-outage/fault.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode storage-outage
# While it is polling, run the outage curl checks; wait for both to finish.
node tests/acceptance/s3-outage/vector-workflow.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode search-outage
python3 tests/acceptance/s3-outage/fault.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode restore
# Wait for the independent watchdog to exit normally and publish its nonintervention receipt.
node tests/acceptance/s3-outage/vector-observe.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --phase vector-restored-before-retry
# Dashboard: click Retry task once, then wait for the target G2 to become ACTIVE.
node tests/acceptance/s3-outage/vector-observe.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --phase vector-g2-ready
node tests/acceptance/s3-outage/vector-workflow.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode search-g2
# Dashboard: sign out normally before the final observation.
node tests/acceptance/s3-outage/vector-observe.mjs --run "$RUN" --scenario VECTOR_PROVISION_V1 --phase vector-signed-out
python3 tests/acceptance/s3-outage/lifecycle.py --run "$RUN" --scenario VECTOR_PROVISION_V1 --mode cleanup
```

Run G1 source checks before the one-shot READY proof so watchdog enrollment does not consume its 90-second freshness budget on transfers. Before the outage, start and prime the observer, wait for its ACK, then invoke the fault; run curl checks while the same reader polls. Starting a cold observer only after worker resume cannot guarantee the first ten-second schedule is observed. After its terminal proof, restore immediately; do not spend the recovery proof's 90-second freshness window on browser work.

Use the existing `abort-incomplete` fault command if control fails; never rerun a partial mutation or refresh a proof/watchdog. The same scoped cleanup is required for any failed setup.

## Validation record

The initial focused pass reports 37 mocked Python tests, 40 pure/injected Node tests and 14 Node syntax checks. The pre-review focused pass after source-proof/epoch refinements passes 37 Python tests, 43 Node tests, 14 Node syntax checks and four Python AST checks. The three changed documents pass formatting, one Mermaid diagram and 79 local Markdown links; `git diff --check` is clean. These cases exercise real helper functions with injected HTTP/PG/process boundaries, not native resources. Production planner execution, current app builds, native source transfers/indexing/search, actual container outage/reconnect, dashboard retry, browser locales and owned teardown remain **NOT_RUN** for this foundation.

The subsequent independent-review correction adds per-query remaining-budget checks and immutable G1/task/epoch continuity. Four new injected cases cover positive completion, exhaustion before later queries/COMMIT, coherent application-plus-physical G1 replacement and task/epoch substitution. The first revision pass rejects one new positive fixture because it omitted the organization binding that the real CLI supplies; the guard is preserved and only that fixture is corrected. The repeated cohesive pass succeeds with 37 Python tests, 47 Node tests, 14 syntax checks and four AST checks. The original disabled inventory remains archived and its provenance is not rewritten. No native trial is implied by this correction.

The actual-main checkpoint subsequently passes scoped API/workers/web/admin type checks and lint, followed by four serialized production builds. These builds use closed synthetic configuration and do not connect to a database or embedding service. Generated Next declarations are restored exactly. Before any run selection, a further source review finds two acceptance-only gaps: the synthetic Ollama fixture omits the dimensioned embedding request used by production, and curl metadata/hash checks reopen its pathname. The fixture now accepts exactly the native probe DTO without dimensions or the native embedding DTO with dimensions equal to three; other fields and dimensions are refused. Curl checks root ownership, file type, non-writable group/world mode, size and pinned SHA on one descriptor opened with `O_RDONLY | O_NOFOLLOW`, then closes it in `finally`.

Five added pure/injected regressions cover both native request bodies and refusals, descriptor continuity despite pathname replacement, metadata/hash drift and descriptor cleanup on failure. The repeated coherent offline pass succeeds with 37 Python tests, 52 Node tests, 14 syntax checks and four AST checks. Earlier source inventories and validation results remain historical, and the separate review revision records the new helper bytes. The product/package/lock tree is unchanged, so production builds are not repeated for these helper-only changes. At that checkpoint no native run had been selected or activated; native outage/retry and browser verification were still **NOT_RUN**.

### First native setup trial and sign-out correction

Run `2aedbacc86f9` at helper commit `e6d4c3d4dc887bb356238532ed9d853362d681f0` prepares four owned stores/volumes, deploys existing migrations and starts the five recorded processes. The one-shot `prepare-g1` command exits with `S3_OUTAGE_VECTOR_HTTP_UNKNOWN_NO_REPLAY`; its exact failing HTTP status and ordinal were not recorded and remain **UNKNOWN**. A subsequent bounded read-only snapshot separately finds one READY document/version, one ACTIVE generation and two COMPLETE PROVISION/INDEX_DOCUMENT tasks with one attempt each, no task error, zero organization credentials/keys and one session. Those database facts do not complete the failed workflow or authorize an outage. No baseline, watchdog, fault, search receipt or browser action is produced.

The final synthetic fixture counters are seven requests, two embedding calls/two inputs and zero rejected requests. Exact cleanup exits zero: all five processes, four stores and four volumes are absent. Lifecycle is restored first, then every one of the 31 archived source pairs verifies exact disabled bytes/modes; all 13 gates are true and the checkout is clean. This remains an **INCOMPLETE** setup trial, not an outage/recovery result.

Source inspection finds a definite request-shape defect: the workflow sends sign-out without a body or Content-Type, whereas the successful native seed sends JSON `{}`. The installed Hono adapter exposes a POST body stream, and Better Auth's parser requires JSON media type; a 415 refusal is therefore a supported source explanation, not a measured status retroactively assigned to this run. The current correction explicitly sends `{}`, preserves the first workflow failure if sign-out also fails, and records only finite finalization booleans. Existing REST success statuses stay strictly 200; the current oRPC contracts do not declare 201/202 overrides.

Each future workflow call writes exclusive 0600 BEFORE/AFTER receipts containing only closed mode, ordinal, method, status or null, scope and a timestamp. AFTER is written before JSON/status assertions; no route, body, header, token or error message is stored. At most 81 calls and 162 HTTP receipt files are possible per one-shot mode, with the existing private-file cap. The remaining deadline is checked again after durable BEFORE and before dispatch. Unknown acceptance, failed receipt persistence and failed sign-out prevent successful output without replay. Six added injected cases exercise the real workflow/attempt functions; the coherent offline suite passes 37 Python, 58 Node, 14 syntax and four AST checks. Production bytes and the prior four builds are unchanged. No replacement native trial is claimed.

### Second trial: successful setup/source checks, rejected READY observation

The fresh run `24d0469b8d95` uses helper commit `950ee085c78651613ec1c1a977430b91dd4d9b50`. Its separate `prepare-g1` and `search-g1` commands each complete with 13 recorded HTTP 200 responses and confirmed sign-out. Curl checks all three search modes and exact source preview/original bytes. Root performs one normal English dashboard login and observes G1 ACTIVE, one published document/child, zero retained/reserved chunks, two complete tasks and no console errors. There is no browser file transfer or Retry action.

The unique `vector-g1-ready` observation then exits with the generic sanitized failure before any complete application snapshot (`snapshots: 0`). It publishes no READY proof, watchdog ACK, pause, outage or retry result. The full trial remains **INCOMPLETE** despite the separately completed setup/search commands. The root browser tab is closed; no late logout or pre-teardown session-zero claim is made. Exact cleanup removes five processes, four stores and four volumes, then restores all 31 archived source pairs/modes, lifecycle first, with all 13 gates true and Git clean. Synthetic final counters are 13 requests, four embedding calls/four inputs and zero rejected requests.

Read-only source diagnosis finds an invalid application query: `Chunk.generationId` is `TEXT` in the existing migration, but the observer compares it with `ANY($2::uuid[])`. PostgreSQL's text/uuid operator mismatch is inferred from that source/schema; SQLSTATE 42883 was **not captured** in this trial. The exact production planner is separately reproduced without services and returns one child/parent, so that reproduction is not an application database or physical-vector proof.

The current acceptance-only correction binds the parameter as `text[]`, preserving the scoped column, parameterization, row/span bounds and READ ONLY transaction. Unknown failures inside the actual application snapshot transaction report only `S3_OUTAGE_VECTOR_READ_APP_SNAPSHOT`; known guard errors remain unchanged, and raw database payloads are never inspected or logged. A pure regression calls the real reader, captures its query and compares the parameter type with the actual migrated column; it rejects the original UUID cast. Another injected case verifies the closed diagnostic against native-looking errors, accessor traps and revoked proxies. The coherent offline suite passes 37 Python tests, 60 Node tests, 14 syntax checks and four AST checks. At that correction checkpoint, the regression did not compile or execute SQL in PostgreSQL; a fresh migrated `_test` run was required. The third trial below later establishes native READY execution separately. Both earlier trials and their archived hashes remain unchanged.

### Third trial: READY established, outage observation incomplete

Fresh run `8aa5a366fd76` at helper commit `ba755dbdfa13eb39e653b4df3a8d829175b479e4` uses the same selected `dc314` production/build tree. Setup completes with 12 HTTP 200 calls, G1 search/source checks with 13 HTTP 200 calls, and both workflows confirm sign-out. Root logs in once normally and observes English G1 ACTIVE, one document/child, zero retained/reserved chunks, two COMPLETE tasks and no console errors. No browser transfer occurs. The unique G1 READY observation now passes on the real migrated application/vector databases, establishing the corrected application SELECT at this boundary. G2 rebuild (five HTTP 200 calls) and the paused staged observation also pass.

The exact vector store is stopped and the same worker resumed under the original watchdog. The separate curl outage workflow passes seven HTTP 200 responses and one expected typed HTTP 409 VECTOR_UNAVAILABLE refusal, including lexical source reads. The outage observer then exits with `S3_OUTAGE_VECTOR_TRACE_BOUND` after 40 snapshots. The old code uses this label both for a twelfth changed row and for a final trace containing fewer than five rows; its failure receipt stores no rows. The exact branch, five-claim completion and all four backoffs are therefore **UNKNOWN**, not reconstructed from elapsed time. The fault receipt is timestamped 18:10:18.170913 UTC; observer-intent mtime is 18:10:27.562467 UTC, approximately 9.392 seconds later, before planner/Prisma initialization. This proves an ordering gap for a ten-second first backoff, not that it caused this specific refusal.

No restored-before-retry proof or Retry UI action occurs. Controlled abort restores the exact store/worker and marks watchdog intervention; the trial remains **INCOMPLETE**. Root closes the tab and clears fixture memory; no late logout or pre-teardown session-zero claim is made. Cleanup exits zero with five processes, watchdog and four stores/volumes gone. All 31 native source pairs/modes are restored lifecycle first, all 13 gates true and Git clean before the offline revision begins. Synthetic final counters are 20 requests, six embedding calls/six inputs and zero rejects. Historical source pins and failed receipts are retained unchanged.

The subsequent disabled revision primes the observer before fault admission, preserves bounded failure traces and checks the exact native retirement task. Actual hermetic validation is 46 Python tests, 67 Node tests, 14 syntax checks and four AST checks. This includes real collector deduplication with Date/BigInt values, missing-first-schedule and separate overflow failures, atomic ACK/intent visibility, staged/read/close ordering, live identity/source/proof tampering, monotone transitions, cleanup drain refusal and the legitimate fifth cleanup task. No application code/build, schema, migration, budget, native task or clock is changed. The revised protocol has **NOT_RUN** natively, all 13 gates stay true and a replacement run is not selected.

Independent review also catches and corrects two pre-activation defects in this revision: a later worker metadata variable named `process` would shadow Node process during ACK creation, and rereading a newer OUTAGE phase after an older worker sample could reject a legitimate transition. The actual ACK publisher now owns its Node clock/private-file path outside that lexical scope and is exercised with real private files; the metadata record is named `processIdentity`. The guard passes one phase captured before worker/store sampling into the transition check. A controlled interleaving admits an older DOWN/paused sample when the newer receipt arrives, while a sample taken in OUTAGE still rejects a paused worker. Earlier offline receipts remain separate; the final 46 Python/67 Node pass includes these corrections and is not native recovery evidence.
