# Interrupted semantic rebuild catalog observer

This is a separately guarded, one-shot **read-only application-catalog observer**. Importing it opens no process, database, provider, HTTP or S3 connection. Explicit CLI calls require the independently enrolled [fault scope](../fault/README.md) and exact current quality ownership/build/schema/source checks. It never overrides those guards, restarts a worker, changes data/deadlines or retries a failed invocation.

The original native observer ended INCOMPLETE on PostgreSQL's offset-free Prisma timestamp representation. The corrected and relocated observer has **not had a native retest**. The [actual acceptance record](../../../../docs/rag-interruption-acceptance.md) distinguishes that formal failure from later independent functional evidence. These tools do not retrospectively repair it.

## Three exclusive checkpoints

- `absent-checkpoint`: independent fault absence admission, original exact worker absent and model resumed; capture actual accepted prefix, plan and complete focused work history. The actual caught cursor is authoritative.
- `expired-before-restart`: same absence admission; the lease/work deadlines must equal the first checkpoint, and database time must actually pass both. Cursor/scores/ranges/checkpoint remain unchanged. No expiry is manufactured.
- `recovered`: ordinary quality dashboard guard with a newly recorded exact live worker; require the earlier successful expired checkpoint, higher task epoch, nondecreasing attempts/continuations, READY sealed B plan, immutable accepted prefix, B ACTIVE/A RETIRED, exact desired/current publication, retained source holds and zero unused reservations. No new BOUNDARY operation can start before the accepted offset. The abandoned intent must honestly be UNCERTAIN with released reservations after its original deadline; another outcome refuses this specific proof.

This means logical accepted-prefix reuse, never wire exactly-once native calls or billing. A later `boundary:32` attempt may repeat uncertain external work and stays charged/reported. Old work identities and complete A+B known/unknown usage/reservations reconcile. The Ollama fixture's billed usage remains unknown.

## Fixed bounded reads

One schema-qualified SELECT gives one within-application-PostgreSQL snapshot, through the existing read-only reader. The fixed scope is one global document/collection, one owner organization and exactly A/B. Bounds are two generations, four publications/plans/holds, two desired-document rows, 24 tasks, 128 lifetime work rows, **640 application chunks with sentinel 641**, and a 1MiB safe snapshot. Two preflight-valid 255-child/44-parent layouts fit; overflow refuses without truncating history. These bounds change no product quota.

No text, source spans, capability JSON, object keys, endpoint, credential, lease token or raw vector/checkpoint leaves SQL. PostgreSQL computes SHA-256 of the stored checkpoint. Child manifests/final ranges, parent containment and application accounting are validated. Retired-generation publications can correctly remain PUBLISHED during grace: their children remain retained. CLEANING/CLEANED generations cannot pass the retained-source recovery proof.

The parser accepts offset-free timestamps only at designated approved Prisma DateTime fields, after the same snapshot proves a UTC/EtcUTC session and actual `timestamp without time zone` types for lease/deadline/uncertainty/retention columns. Database clock values and arbitrary strings require an explicit offset. Raw strings are unchanged. A wrong type/session refuses rather than assuming a host/browser timezone. The updated SQL projection still requires isolated compilation before any fresh native trial.

Physical vectors, originals, source receipts, search availability and browser recovery remain separate [reconciliation](../physical-proof.md) / acceptance steps. `CATALOG_CHECKPOINT_RECORDED` is never overall recovery/capacity PASS.

## Sources and private outputs

`observer-manifest.json` binds exactly the two observer runtime modules and the two sibling fault modules. It is verified before fault admission. A changed file refuses; do not regenerate a manifest to adopt code into an old checkpoint/run. The global [helper provenance](../helper-provenance.json) separates actual native, fixed shadow and relocated hashes.

Only new owned private files are written under `node_modules/.cache/vectorix/m7c-interruption-observer-RUN/`: one exclusive STAGE-invocation.json before observation and one STAGE.json with safe assessment/snapshot or INCOMPLETE diagnostic. Existing output refuses replay. The shared nofollow/current-UID 0700/0600 synchronized writer is reused. `canonicalProofSha256` and snapshot hashes use compact canonical JSON excluding the writer's newline; manifest/fault hashes use exact file bytes.

```sh
python3 -B tests/acceptance/interruption/observer/recovery_observer.py \
  --run RUN --stage absent-checkpoint \
  --organization ORG --collection COLLECTION \
  --old-generation A --generation B --document DOCUMENT
```

Use the same exact scope for expired-before-restart only after natural deadlines, then recovered only after ordinary worker restart/B activation. A missed stage, deadline exhaustion or unknown outcome remains INCOMPLETE. Never delete a journal to retry.

## Offline tests

```sh
python3 -B tests/acceptance/interruption/observer/recovery_observer_test.py
```

Tests are synthetic/mocked only. They cover prefixes, native-shape timestamps, exact deadlines, epochs, lifetime work/uncertainty/accounting, retained-generation PUBLISHED candidates, geometry/holds/manifests, bounds, actual existing reader prefix/byte checks with I/O boundaries mocked, exclusive outputs and no replay. Disabled-entry tests explicitly patch the flag True; enabled entry points get invalid arguments and must refuse before any valid live state or resource access. No test rewrites historical sources or supplies a new formal native PASS.
