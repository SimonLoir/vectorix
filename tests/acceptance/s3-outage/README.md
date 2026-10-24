# Isolated S3 outage acceptance — protocol 2

**Current status: all 13 execution gates disabled.** Protocol-2 cleanup run `8070c4f9162b` passes at the historical sources recorded in the [cleanup results](../../../docs/rag-s3-cleanup-acceptance.md#actual-isolated-trial--october-24-2026); its observer-finalization follow-up has offline coverage only. Protocol-2 ingestion remains NOT_RUN. This revision reuses the owned topology, fault controls and bounded I/O for three explicit scenarios: `INGESTION_V1`, `CLEANUP_V1` and `VECTOR_PROVISION_V1`. Every lifecycle, fault and Node command requires `--scenario`; old states and cross-scenario receipts are refused. Cleanup uses a distinct `vectorix-m7c-s3-cleanup-<12hex>` namespace. No command starts merely by importing a module. Every new run requires a fresh review and deliberate activation; previous run receipts cannot be replayed.

The disabled [vector provisioning foundation](../../../docs/rag-vector-outage-acceptance.md) uses its own `vectorix-m7c-vector-provision-<12hex>` namespace, one synthetic embedding process and session-curl transfers. Its native journey remains NOT_RUN. G1 stays active through five natural G2 provision failures, with exact manifest/task/epoch continuity required before a later explicit dashboard Retry task. It does not attest a model's weights or a fault inside DDL/write/seal.

**Historical result remains separate:** protocol 1's ingestion run `1f27f31a0d52` was verified and delivered in PR #79. Its 17 archived sources, seven-gate activation/restoration and results remain unchanged in `provenance.json` and the [actual ingestion acceptance guide](../../../docs/rag-s3-outage-acceptance.md). That result is not a native execution of protocol 2 and cannot be adopted as a new run. The current source inventory is recorded separately. No frozen corpus, prior private source archive or old proof is regenerated.

`INGESTION_V1` retains the stored-replacement/extraction-retry journey below, including seven-day retention. `CLEANUP_V1` uses one disposable READY source and a single controlled native HTTP DELETE with retention zero; browser deletion is excluded. It then proves natural failed physical cleanup, same-store restoration, dashboard Retry cleanup and final physical absence/accounting. See the [cleanup acceptance guide](../../../docs/rag-s3-cleanup-acceptance.md). Other dependency faults, semantic interruption, providers, quality and capacity remain outside these scenarios.

**Transfer policy:** the browser upload/download steps below document historical manual recipes and must not be repeated. Future file transfers use curl with an authorized, least-privilege API key or a native session when the operation is session-restricted. Library API keys cannot upload or replace documents and cannot read an isolated-library document without collection authorization. The historical S3 ingestion/cleanup recipes do not implement unattended transfer setup. The new vector scenario has a separate closed session-curl workflow. Browser checks remain available for ordinary sign-in and dashboard inspection, plus the vector recipe's explicit Retry task; no browser file transfer is allowed.

## Prerequisites and ownership

Use the locked Node/pnpm versions, Python 3.10+ on Linux with `/proc`, pidfds and Docker access, and the four exact existing local image IDs in `lifecycle.py`. No image is pulled. Build API, workers, web and admin before preparation. Copy web `public` and `.next/static` beneath `.next/standalone/apps/web`, and admin `.next/static` beneath `.next/standalone/apps/admin`, matching the existing Docker layout. Admin is pinned but not launched. The CLI never builds or copies assets.

`lifecycle.py` creates four new stores/volumes and exact `_test` databases under the selected fresh scenario namespace. Containers are loopback-bound and constrained; IDs, image IDs, creation metadata, labels, mounts, volume fingerprints, resource limits and consumers are checked. Production API/web/workers and bounded loopback SMTP are separate owned foreground processes with exact UID/PID/start ticks/boot ID/cwd/entry/environment. No model, hosted service, external inbox, application database or previous run is reused.

Before preparation, the owned, canonical `node_modules/.cache/vectorix` parent and the two source/fixture directories must use mode `0700` or `0755`. Existing group-writable `0775` directories fail before admission. Normalize only these owned directories; do not relax the validator or change a pinned run. New private run directories remain `0700`, with private files `0600`.

State, secrets, fixture, mail, logs and proofs live only in `node_modules/.cache/vectorix/<selected-namespace>-<run>` (`0700`, files `0600`). Tracked sources/fixtures may use ordinary checkout modes `0755`/`0644`; they contain no secrets. The source/build/migration/helper pins and fixed TXT hashes are checked at admission. Runtime closure bounds remain 96 packages, 12,000 files, 512 MiB total, 64 MiB per file and 60 seconds. This is the enumerated Prisma/tsx/AWS closure plus existing bundle/standalone bytes, not an attestation of every backend external dependency or OS library. Configuration is generated from fresh private state, without `.env`, host AWS profiles or hosted keys.

Seed creates exactly one ordinary unverified account and organization through native HTTP, sets its active organization and signs out. It performs no ORM write, credential creation, role change, group/grant action or API-key creation. The private platform S3 fallback points only to the newly owned RustFS bucket. Native account EMAIL delivery may occur; SMTP remains limited to 64 connections/four sockets/32 messages/64 KiB per message/2 MiB total, with five-second idle and 30-second connection deadlines. There is no invented SMTP lifetime or zero-mail claim. Root owns finite journey timing and cleanup.

## Ingestion sequence and the single safety deadline

The independent watchdog must be enrolled **after selecting the v2 file** and before pausing. The browser's potentially slow file chooser must never be opened while the worker is stopped. Complete file selection, then create the unique `v1-ready` observation immediately before enrollment; the admission proof must be at most 90 seconds old. Never overwrite or refresh an earlier observation to conceal a stalled chooser. An expired precondition means an incomplete run.

1. Upload `fixtures/s3-outage-v1.txt` normally and wait for READY. Preview/download it and record the exact frozen SHA. Open the replacement dialog and select `fixtures/s3-outage-v2.txt` without submitting. Keep retention at seven days.
2. Run the unique `v1-ready` observer. Start the independent `fault.py --mode watchdog` foreground process and wait for both its durable `watchdog-ack.json` and actual ACK output. Its **one 900-second monotonic deadline starts before enrollment validation**. It covers enrollment, pause, upload, staged object proof, S3 stop, every retry/backoff and restoration. No command refreshes it.
3. Invoke `pause-worker --file-selected`. The flag records an operator confirmation of prior file selection, not a fabricated DOM observation. The command checks the ACK/live watchdog and exact worker identity, then signals only that worker through its pidfd and verifies state T.
4. Submit the already selected replacement in the dashboard. The API stores v2 while the worker is paused. Run `v2-staged`: v2 must have storedAt, PENDING ingestion, attempts zero, no claim, no extraction and a physical original with the exact fixture SHA. v1 remains READY. The independent staged proof is required before faulting storage.
5. Invoke `storage-outage`. It stops only the saved RustFS ID with its unchanged mount/volume, then sends SIGCONT to the same saved worker PID. The real scheduler, retry policy, configuration, credentials and clocks remain unchanged. No manual processor call or SQL task update occurs.
6. Run `outage-failed`. This observation is DB-only; it never constructs an S3 client. Its bounded polling remains inside the original ACK deadline, records natural backoffs and requires terminal attempt five / FAILED / STORAGE_UNAVAILABLE. A future leasedUntil on nonterminal PENDING work is a retry deadline; the null lease token means it is not an active claim. Terminal availableAt may remain in the future and does not prevent the later explicit native retry.
7. Invoke `restore` after the fresh independent terminal proof. It starts the **same** RustFS ID on the **same** volume and confirms the same worker is running. Wait for `watchdog-final.json` with intervened=false **and the watchdog process's successful exit**. Then run `restored-before-retry`, which checks exact retained sources and absent v2 extraction. Merely restoring S3 must not requeue terminal FAILED work.
8. Open version history, click extraction retry once and wait for that same v2 to become READY. Run `v2-ready`, inspect exact preview/original and source identity, then sign out normally and run `signed-out`. Retry legitimately resets attempts to zero, so preserve the pre-retry five-claim proof separately. v1 remains charged with its accepted future retirement; this is not an empty-work-queue or physical-cleanup result.

Real extraction claims use 180-second leases. Four natural backoffs are 20/40/80/160 seconds, totaling **at least 300 seconds**, plus I/O and scans. The source configures two SDK attempts and 30-second send aborts; a conservative planning estimate of five claims × 60 seconds + 300 seconds backoff + five 5-second scans is 625 seconds. This is not a measured SLA or a general streaming deadline. The single 900-second watchdog remains authoritative, including all earlier staging time. It must restore exact owned resources if tools stall; it cannot provide a second window for a late retry sequence.

Any watchdog intervention writes immutable evidence before restoration and forces **INCOMPLETE**, even if service recovery later succeeds. Controller exceptions, process death, partial intents, failed restoration, missed observations or nonzero helper exits also remain incomplete. There is no replay, policy retuning, clock advance or repaired PASS. Preserve all failed evidence and use a fresh run for a separate trial.

## Cleanup sequence, after explicit activation only

Pass `--scenario CLEANUP_V1` on **every** command and use a fresh `S3_CLEANUP_RUN`; never reuse an ingestion state. Preparation, migration deployment, native seed, SMTP/API/web/workers startup and private fixture handling follow the same prerequisites. Only the scenario namespace, database names, labels and generated platform bucket differ.

1. Sign in normally and upload only `fixtures/s3-outage-v1.txt`. Wait for READY and verify its exact preview/original. The baseline observer requires one version/extraction, zero reservations, no ingestion lease, no source holds and no index tasks. No replacement is created.
2. Emit `cleanup-ready` once, then start the independent watchdog and wait for its ACK. Pause the exact worker with `--fixture-ready` (not `--file-selected`). The original 900-second window includes all subsequent fixture authentication, deletion, object proof, outage and restoration.
3. Invoke `cleanup-fixture.mjs` once. A new owned owner session performs native sign-in/set-active/current-session checks, exactly one DELETE for the baseline's document/version with `retentionDays: 0`, then sign-out. A durable intent precedes HTTP. At most five operations have bounded private BEFORE/AFTER status receipts. The helper checks **at least 625 seconds remain immediately before DELETE**, after writing its BEFORE receipt. Unknown acceptance is INCOMPLETE and never replayed.
4. Emit `cleanup-staged` while the worker is still paused. It requires the confirmed DELETE receipt, DELETED tombstones, PENDING cleanup with attempt zero/no claim, unchanged original/extraction and exact retained quota. Native deletion changes the old READY ingestion row to historical FAILED/ACCESS_REVOKED; it is not unresolved extraction work.
5. Invoke `storage-outage`. Immediately before stopping the exact RustFS ID, the fault control checks at least 625 seconds remain from the **same** original watchdog. It then resumes the same worker PID. A late refusal invokes the independent safety restoration and permanently records INCOMPLETE.
6. Emit `cleanup-outage-failed`. This phase creates no S3 client. Bounded 2-second polling observes all four PENDING backoffs (20/40/80/160 seconds) and terminal FAILED / attempt five / STORAGE_UNAVAILABLE. Cleanup retries have null lease tokens **and null leasedUntil**, unlike ingestion's future retry deadline. The trace allows at most 16 state changes because native cleanup marks PROCESSING before incrementing its attempt in a separate transaction. Five durable destructive claims do not imply five S3 wire requests. Original/extraction remain charged; source readability is not claimed while S3 is stopped.
7. Invoke `restore`, then wait for the watchdog's nonintervening final receipt **and successful process exit**. Emit `cleanup-restored-before-retry`: the same original and artifact must still physically match. Partial purge is an incomplete result for this stop-before-first-delete trial.
8. Open Documents → Deleted → lifecycle and click **Retry cleanup** once. Do not click a browser deletion confirmation. Emit `cleanup-complete` only after the actual worker completes: cleanup COMPLETE, discarded original/extraction, content PURGED, storage/reservations zero, no source holds/index work, and independent HEAD 404 for original, `text.txt` and possible `extraction.json`. The document/version tombstones remain; no row-erasure claim is made. Preserve FAILED5 before native retry resets its attempt count.
9. Sign out normally, emit `cleanup-signed-out`, then clean all owned resources. Any intervention or partial intent permanently prevents PASS.

```bash
node tests/acceptance/s3-outage/cleanup-observe.mjs --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --phase cleanup-ready
python3 tests/acceptance/s3-outage/fault.py --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --mode watchdog
# Separate foreground watchdog; wait for its ACK before these later steps.
python3 tests/acceptance/s3-outage/fault.py --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --mode pause-worker --fixture-ready
node tests/acceptance/s3-outage/cleanup-fixture.mjs --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1
node tests/acceptance/s3-outage/cleanup-observe.mjs --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --phase cleanup-staged
python3 tests/acceptance/s3-outage/fault.py --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --mode storage-outage
node tests/acceptance/s3-outage/cleanup-observe.mjs --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --phase cleanup-outage-failed
python3 tests/acceptance/s3-outage/fault.py --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --mode restore
```

After the original watchdog exits successfully, run the remaining three observation phases around the actual dashboard retry and sign-out. Cleanup is `lifecycle.py --run "$S3_CLEANUP_RUN" --scenario CLEANUP_V1 --mode cleanup`. The safety-only `fault.py --mode abort-incomplete` may restore enrolled resources after a failed fixture invocation; it never retries DELETE or clears intervention evidence.

## Ingestion commands, after explicit activation only

Choose a fresh 12-hex `S3_OUTAGE_RUN`; define it in every terminal. These are repeat instructions, not permission to reuse the recorded run or its archived state:

```bash
python3 tests/acceptance/s3-outage/lifecycle.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode prepare
python3 tests/acceptance/s3-outage/lifecycle.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode deploy-existing-migrations
```

For ingestion, pass `--scenario INGESTION_V1` on every command. Start `--mode app-smtp` and `--mode app-api` in separate owned foreground sessions. Wait for the private SMTP-ready receipt and actual API health, then execute `--mode seed` once. Start `--mode app-web` and `--mode app-workers` after READY, also as separate foreground sessions. Read fixture credentials only privately for normal browser sign-in. Do not print the fixture/state or open credential/key/role controls.

```bash
node tests/acceptance/s3-outage/observe.mjs --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --phase v1-ready
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode watchdog
```

The watchdog command remains running in its own foreground session. Only after its ACK, invoke these controls in another session at the sequence points described above:

```bash
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode pause-worker --file-selected
node tests/acceptance/s3-outage/observe.mjs --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --phase v2-staged
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode storage-outage
node tests/acceptance/s3-outage/observe.mjs --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --phase outage-failed
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode restore
```

Then wait for the watchdog's nonintervening final receipt/exit, and use the remaining fixed observation phases around the actual dashboard retry/sign-out. Do not delete the document or click any irreversible deletion confirmation. No notification permission, role, key, credential change or restoration is part of the browser recipe.

## Guard and evidence contract

Normal `observe` still requires online stores and running processes. `staged-observe` separately requires RustFS online and the exact worker stopped. `outage-observe` separately requires the exact owned RustFS stopped and the same worker running. These are closed fault states, not a relaxed normal resource guard. Outage state can prove v1 retained/published in the database, but **cannot promise readable S3 original/preview while storage is down**. UI metadata/history can remain useful; record the actual localized storage error without exposing provider details.

`watchdog-ack.json` binds the run, original deadline, baseline proof SHA, control identity, saved worker identity and RustFS identity. Every controller action has one exclusive intent and receipt; atomic hard-link publication prevents a reader seeing a partial JSON receipt. Intervention evidence has precedence over any later restore receipt. Only enrollment and ACK publication briefly hold the lifecycle lock, preventing cleanup from overlooking an unenrolled control process. The running monitor and safety restoration hold no lifecycle lock and attempt container restoration and worker resumption independently, so a failed store start cannot strand a stopped worker. Its limited safety path uses only enrolled resource identities and never changes business state.

The observer owns immutable source/claim/quota proofs, original/extraction bytes and metadata rereads. It selects no raw lease token or credential ciphertext. Original/extraction sizes, hashes, saved platform binding, source IDs, reservation and publication must match the phase; S3 reads are bounded and happen outside DB transactions, followed by rechecks. This is rechecked cross-store evidence, not an atomic/quiesced snapshot. Operational telemetry is supplemental best effort, not exact billing, queue completeness or worker health. The repeating scheduler and v1 future retirement may remain after successful recovery.

## Cleanup and source map

Root invokes cleanup even after an incomplete trial:

```bash
python3 tests/acceptance/s3-outage/lifecycle.py --run "$S3_OUTAGE_RUN" --scenario INGESTION_V1 --mode cleanup
```

Cleanup first terminates and waits for the identity-checked watchdog, then resumes an identity-matching stopped worker before graceful SIGTERM. It waits for owned processes, uses no SIGKILL, and removes only exact owned containers/volumes after fingerprint/consumer checks. Private evidence is retained. Root separately closes only owned browser tabs and removes only exact-path/hash-checked synthetic downloads. Never touch model volumes or user/application resources.

`lifecycle.py` owns exact topology, clean environment, source/build/runtime pins and guard states. `private.mjs` supplies private I/O and guarded read-only Prisma. `seed.mjs`, `bucket.mjs` and `smtp.mjs` own bounded synthetic setup. `fault.py` owns closed pidfd/container controls and the independent original-deadline watchdog. `observe.mjs`, `objects.mjs` and `fixtures/` provide ingestion/source evidence; `cleanup-fixture.mjs` and `cleanup-observe.mjs` are the two focused cleanup modules. The latter reuses the existing bounded snapshot reader and object transport rather than cloning a second topology. `lifecycle_test.py` and `fault_test.py` retain their mocked/offline cases and add protocol/scenario/deadline regressions; `cleanup.test.mjs` covers the one-shot native sequence with injected transport, exact current/retained/discarded states and cleanup backoffs. Run the current offline suite through `pnpm test:s3-outage:guards`, which is included in catalog CI. The preceding cleanup-only pass is 31 Python plus 28 Node cases and eight Node syntax checks. The reviewed vector checkpoint passes 37 Python plus 47 Node cases, 14 Node syntax checks and four Python AST checks; independent source review is CLEAR. Final composed-tree validation is recorded separately. Offline results do not establish a real outage. `provenance.json` preserves protocol-1 derivation/native inventories and adds a separate disabled protocol-2 current inventory; no historical hash is presented as a current native execution. The public outcome guide records only validation and browser actions that actually ran.
