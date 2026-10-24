# Isolated S3 ingestion outage acceptance

Status: **one native ingestion recovery trial verified; checkout disabled by default**. The [actual acceptance guide](../../../docs/rag-s3-outage-acceptance.md) records run `1f27f31a0d52`, six read-only checkpoints, the separately observed French dashboard journey and cleanup. Its independently reviewed enabled sources are archived; all seven runtime gates are restored exactly before delivery documentation changes. A fresh deliberate run requires source review, offline validation and gate-only activation again. Checking out these files does not start resources, build software, generate migrations or configure a provider.

This is the ingestion part of M7c's outage matrix. One READY document receives a fully stored replacement while the exact worker is stopped; only its owned RustFS container is stopped, then that same worker resumes and exhausts its natural retries. The same container and volume return, and the dashboard retries the same immutable replacement. Cleanup outages, Redis/vector faults, other crash stages, providers, quality and capacity are outside this slice. Seven-day retirement remains pending; no document is deleted or prematurely purged.

## Prerequisites and ownership

Use the locked Node/pnpm versions, Python 3.10+ on Linux with `/proc`, pidfds and Docker access, and the four exact existing local image IDs in `lifecycle.py`. No image is pulled. Build API, workers, web and admin before preparation. Copy web `public` and `.next/static` beneath `.next/standalone/apps/web`, and admin `.next/static` beneath `.next/standalone/apps/admin`, matching the existing Docker layout. Admin is pinned but not launched. The CLI never builds or copies assets.

`lifecycle.py` creates four new stores/volumes and exact `_test` databases under a fresh `vectorix-m7c-s3-outage-<12hex>` namespace. Containers are loopback-bound and constrained; IDs, image IDs, creation metadata, labels, mounts, volume fingerprints, resource limits and consumers are checked. Production API/web/workers and bounded loopback SMTP are separate owned foreground processes with exact UID/PID/start ticks/boot ID/cwd/entry/environment. No model, hosted service, external inbox, application database or previous run is reused.

Before preparation, the owned, canonical `node_modules/.cache/vectorix` parent and the two source/fixture directories must use mode `0700` or `0755`. Existing group-writable `0775` directories fail before admission. Normalize only these owned directories; do not relax the validator or change a pinned run. New private run directories remain `0700`, with private files `0600`.

State, secrets, fixture, mail, logs and proofs live only in `node_modules/.cache/vectorix/vectorix-m7c-s3-outage-<run>` (`0700`, files `0600`). Tracked sources/fixtures may use ordinary checkout modes `0755`/`0644`; they contain no secrets. The source/build/migration/helper pins and fixed TXT hashes are checked at admission. Runtime closure bounds remain 96 packages, 12,000 files, 512 MiB total, 64 MiB per file and 60 seconds. This is the enumerated Prisma/tsx/AWS closure plus existing bundle/standalone bytes, not an attestation of every backend external dependency or OS library. Configuration is generated from fresh private state, without `.env`, host AWS profiles or hosted keys.

Seed creates exactly one ordinary unverified account and organization through native HTTP, sets its active organization and signs out. It performs no ORM write, credential creation, role change, group/grant action or API-key creation. The private platform S3 fallback points only to the newly owned RustFS bucket. Native account EMAIL delivery may occur; SMTP remains limited to 64 connections/four sockets/32 messages/64 KiB per message/2 MiB total, with five-second idle and 30-second connection deadlines. There is no invented SMTP lifetime or zero-mail claim. Root owns finite journey timing and cleanup.

## Fixed sequence and the single safety deadline

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

## Commands, after explicit activation only

Choose a fresh 12-hex `S3_OUTAGE_RUN`; define it in every terminal. These are repeat instructions, not permission to reuse the recorded run or its archived state:

```bash
python3 tests/acceptance/s3-outage/lifecycle.py --run "$S3_OUTAGE_RUN" --mode prepare
python3 tests/acceptance/s3-outage/lifecycle.py --run "$S3_OUTAGE_RUN" --mode deploy-existing-migrations
```

Start `--mode app-smtp` and `--mode app-api` in separate owned foreground sessions. Wait for the private SMTP-ready receipt and actual API health, then execute `--mode seed` once. Start `--mode app-web` and `--mode app-workers` after READY, also as separate foreground sessions. Read fixture credentials only privately for normal browser sign-in. Do not print the fixture/state or open credential/key/role controls.

```bash
node tests/acceptance/s3-outage/observe.mjs --run "$S3_OUTAGE_RUN" --phase v1-ready
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --mode watchdog
```

The watchdog command remains running in its own foreground session. Only after its ACK, invoke these controls in another session at the sequence points described above:

```bash
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --mode pause-worker --file-selected
node tests/acceptance/s3-outage/observe.mjs --run "$S3_OUTAGE_RUN" --phase v2-staged
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --mode storage-outage
node tests/acceptance/s3-outage/observe.mjs --run "$S3_OUTAGE_RUN" --phase outage-failed
python3 tests/acceptance/s3-outage/fault.py --run "$S3_OUTAGE_RUN" --mode restore
```

Then wait for the watchdog's nonintervening final receipt/exit, and use the remaining fixed observation phases around the actual dashboard retry/sign-out. Do not delete the document or click any irreversible deletion confirmation. No notification permission, role, key, credential change or restoration is part of the browser recipe.

## Guard and evidence contract

Normal `observe` still requires online stores and running processes. `staged-observe` separately requires RustFS online and the exact worker stopped. `outage-observe` separately requires the exact owned RustFS stopped and the same worker running. These are closed fault states, not a relaxed normal resource guard. Outage state can prove v1 retained/published in the database, but **cannot promise readable S3 original/preview while storage is down**. UI metadata/history can remain useful; record the actual localized storage error without exposing provider details.

`watchdog-ack.json` binds the run, original deadline, baseline proof SHA, control identity, saved worker identity and RustFS identity. Every controller action has one exclusive intent and receipt; atomic hard-link publication prevents a reader seeing a partial JSON receipt. Intervention evidence has precedence over any later restore receipt. Only enrollment and ACK publication briefly hold the lifecycle lock, preventing cleanup from overlooking an unenrolled control process. The running monitor and safety restoration hold no lifecycle lock and attempt container restoration and worker resumption independently, so a failed store start cannot strand a stopped worker. Its limited safety path uses only enrolled resource identities and never changes business state.

The observer owns immutable source/claim/quota proofs, original/extraction bytes and metadata rereads. It selects no raw lease token or credential ciphertext. Original/extraction sizes, hashes, saved platform binding, source IDs, reservation and publication must match the phase; S3 reads are bounded and happen outside DB transactions, followed by rechecks. This is rechecked cross-store evidence, not an atomic/quiesced snapshot. Operational telemetry is supplemental best effort, not exact billing, queue completeness or worker health. The repeating scheduler and v1 future retirement may remain after successful recovery.

## Cleanup and source map

Root invokes cleanup even after an incomplete trial:

```bash
python3 tests/acceptance/s3-outage/lifecycle.py --run "$S3_OUTAGE_RUN" --mode cleanup
```

Cleanup first terminates and waits for the identity-checked watchdog, then resumes an identity-matching stopped worker before graceful SIGTERM. It waits for owned processes, uses no SIGKILL, and removes only exact owned containers/volumes after fingerprint/consumer checks. Private evidence is retained. Root separately closes only owned browser tabs and removes only exact-path/hash-checked synthetic downloads. Never touch model volumes or user/application resources.

`lifecycle.py` owns exact topology, clean environment, source/build/runtime pins and guard states. `private.mjs` supplies private I/O and guarded read-only Prisma. `seed.mjs`, `bucket.mjs` and `smtp.mjs` own bounded synthetic setup. `fault.py` owns closed pidfd/container controls and the independent original-deadline watchdog. `observe.mjs`, `objects.mjs` and `fixtures/` provide independent source evidence. `lifecycle_test.py` and `fault_test.py` provide 23 mocked/offline Python cases; the two Node files provide 15 pure/injected cases. All 38 pass through `pnpm test:s3-outage:guards`, which is included in catalog CI. Offline results do not establish a real outage. `provenance.json` distinguishes the retained private derivation, prepared disabled inventory, executed enabled inventory and final disabled delivery. The public outcome guide records only validation and browser actions that actually ran.
