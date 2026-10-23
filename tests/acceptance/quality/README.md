# Isolated reference-quality acceptance

This Linux operator workflow checks retrieval quality through normal authentication, upload, indexing, search, grants and exact-source APIs. It owns a fresh synthetic workspace with three users, two organizations, 24 shared documents and three independently indexed collections. The fixtures, evaluator, guarded collector and owned-resource lifecycle are included here; load and latency drafts are excluded.

The completed native run `2c5589639f5d` used product commit `d7cf7c28f3aef2d2fdbcf270214504d601d836eb` and passed all 720 scored query cells, 72 source proofs and 12 access controls. Dashboard verification followed, and exact owned-resource cleanup reached `CLEANED_EVIDENCE_RETAINED`. This records the already completed run with the archived helper paths. **The relocated helpers have not been retested against a native provider.** Their local guard/protocol/scorer tests and deterministic parser regeneration are separate evidence. [Helper provenance](helper-provenance.json) records the 14 actual archived runtime helper hashes and separately compares 25 pre-relocation/relocated sources, including tests and generators. The broader comparison of 25 files does not claim those files were all snapshotted or executed in the native run. No private run files are copied.

This small reference corpus does not establish ANN recall, 100,000-child indexing, ten concurrent searches, load latency, worker fairness, paid-provider access or production sizing. Those remain separate acceptance work in the [implementation plan](../../../docs/rag-implementation-plan.md). The [native quality record](../../../docs/rag-reference-quality.md) and [build log](../../../docs/build-task-log.md) record milestone delivery.

## Corpus and fixed conditions

The byte-frozen `reference-v1/` contains 24 originals and their 24 actual canonical extraction artifacts, plus source manifests, queries, qrels, policy and local preflight metadata. It has 12 French and 12 English documents: six each TXT, Markdown, PDF and DOCX, including eight parallel fact families and four near-miss families. These artificial rules describe no real organization. The final set has 40 queries, 20 per language, with ten exact, paraphrase, filter and parent-context questions each. Eight development queries are separate and unscored.

The frozen corpus digest is:

```text
cb372b53964ffe896bb4e3c3c44831db6c0949bbe622e63ce0a482607be6fdbc
```

Qrels bind exact source versions and canonical answer ranges rather than generated chunk IDs or a model ranking. Offsets are **UTF16_CODE_UNITS**, matching JavaScript `text.slice(start, end)`; canonical hashes use UTF-8 and original hashes use the original file bytes. Preserve composed/decomposed accents and astral characters. The EXACT queries intentionally use identifier/keyword lookups compatible with PostgreSQL websearch AND semantics. Do not replace missing hits with easier queries after inspecting a model's results.

Each collection uses one of `DOCUMENT_STRUCTURE`, `TOKEN_WINDOW` and `SEMANTIC`, with parent context. Fixed settings are target 512/minimum 128/maximum 768/overlap 64, parent maximum 2048, semantic percentile 90, cosine/float32, DISKANN, empty preparation and the declared metadata schema. The native baseline is local Ollama `embeddinggemma:latest`, full 768 dimensions, `EMBEDDING_GEMMA`, verified weight digest:

```text
85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1
```

A model name or hosted capability fingerprint cannot replace that weight identity. See the [Ollama setup guide](../../../docs/rag-ollama-embeddinggemma.md). The deterministic geometry preflight uses a planning envelope of 6,144 bytes; the runtime must use its genuinely verified native capability snapshot. Preflight unitization and historical `NOT_RUN` fields in the frozen policy/parser records describe preparation, not the later native outcome. They remain unchanged to preserve the predeclared digest.

Run 40 queries × 3 retrieval modes (`LEXICAL`, `VECTOR`, `HYBRID`) × 3 chunkers × 2 repeats, with `topK: 10`: **720 cells**. Use the worse repeat. Every chunker/repeat must meet the fixed gates:

| Gate                       | Required result                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Safety, sources and access | Zero scope/version/provenance/filter/hash violations; allowed reader, foreign organization, revoked grant and old-receipt controls |
| Exact lexical              | Hit@5 =10/10                                                                                                                       |
| Hybrid                     | Hit@5 ≥32/40, ≥16/20 per language; MRR@10 ≥0.65                                                                                    |
| Cross-language hybrid      | Hit@5 ≥3/4                                                                                                                         |
| Filter hybrid              | Hit@5 ≥9/10, with every returned result satisfying its filter                                                                      |
| Parent-context hybrid      | ≥8/10 relevant children with an attached parent covering both required answer ranges within the top 5                              |
| Completeness               | All 720 cells observed, with zero request errors                                                                                   |

Hit@5 is query success, not exhaustive corpus recall. MRR retains raw response rank. FactRecall@10 counts each required logical answer span once across overlapping children/translations. A parent containing an answer behind an unrelated matched child is not a hit. Missing evidence produces `INCONCLUSIVE`; contradictory evidence produces `FAIL`. Missing/error cells remain in their fixed denominators. Perfect synthetic captures remain `NOT_RUN` for live acceptance.

## Offline checks

Install the repository's frozen workspace dependencies, then run from its root:

```sh
pnpm test:quality:guards
node tests/acceptance/quality/validate-preparation.mjs
```

The guard command runs 87 tests: 17 mocked Python lifecycle/policy tests, five child-outcome tests, 21 injected bootstrap tests, six bucket tests, 11 collector/transport tests and 27 evaluator tests. It starts no services and makes no HTTP, database, Docker, S3 or model calls. The enabled runtime entry points still reject malformed arguments and wrong private state before resource/client work. The optional draft switches remain independently tested as refusals; no test uses a draft bypass to simulate a real run.

The fixture validator checks all 56 frozen file hashes, including all 24 originals and 24 canonical artifacts, and recomputes the scored corpus digest. Tests do not write synthetic reports into the reference directory.

For local source/parser regeneration, existing worker dependencies and `/usr/bin/pdfinfo`, `/usr/bin/pdftotext` and `/usr/bin/prlimit` are required. Use a new empty directory with mode `0700` under the ignored cache; generators refuse the tracked fixture directory and nonempty output:

```sh
mkdir -p node_modules/.cache/vectorix
quality_regen="$(mktemp -d "$PWD/node_modules/.cache/vectorix/quality-regeneration-XXXXXXXX")"
python3 -B tests/acceptance/quality/build-sources.py --output-directory "$quality_regen"
pnpm --filter workers exec node --import tsx ../../tests/acceptance/quality/prepare.mts --directory "$quality_regen"
node tests/acceptance/quality/validate-preparation.mjs --generated "$quality_regen"
```

This invokes the production PDF/DOCX parsers on local artificial originals; TXT/Markdown follow `utf8-text-v1` normalization. It compares 55 regenerated files byte for byte and the parser proof except its explicitly current Git commit. The frozen historical parser proof itself is still checked byte for byte. A different parser/tool output fails verification; do not overwrite the frozen corpus to conceal it. Remove only the newly generated directory after inspection. No native embeddings or application data are involved.

## Fresh owned runtime

Prerequisites are Linux with `/proc`, Python 3.10+, Docker, the supported Node.js/pnpm versions, already packaged production API/worker/web builds, locally available selected images and an explicit existing plain local Ollama model volume. The helper uses immutable local image IDs and `--pull=never`; it installs/builds nothing and reads no checkout `.env`. The initial free-disk refusal floor is 4 GiB, not a capacity certificate. Standalone web assets must be copied before preparation pins the build tree.

Each fresh run with a 12-character hexadecimal identifier owns five loopback-only containers: application PostgreSQL, vector PostgreSQL, Redis, RustFS and Ollama. Four store volumes are new and removable. The explicitly supplied model volume is mounted read-only and is never deleted. Application/vector database names are exactly `vectorix_m7c_quality_{app,vectors}_RUN_test`. API/web/auth/trusted origins use `127.0.0.1` with separate ports. Hosted keys/endpoints, mail and inherited credentials are excluded.

```mermaid
flowchart LR
  Prepare[Fresh owned topology and exact source pins] --> Bootstrap[Three synthetic users and two organizations]
  Bootstrap --> Guard[Independent container process tenant and schema guards]
  Guard --> Upload[24 normal uploads and saved association metadata]
  Upload --> Index[Three normal native index generations]
  Index --> Sources[72 exact-source receipt proofs]
  Sources --> Queries[720 fixed query cells]
  Queries --> Access[12 current access controls]
  Access --> Score[Private capture and offline score]
  Score --> Dashboard[Dashboard verification]
  Dashboard --> Cleanup[Exact resource cleanup and retained private evidence]
```

Prepare against a clean committed production tree. A new run pins HEAD, lockfile, Prisma configuration, migration SQL, helper hashes, corpus digest, immutable images and complete built trees. Never edit old pins/state to adopt the relocated paths or another resource.

```sh
quality_run="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(6).toString("hex"))')"
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode prepare --model-volume YOUR_EXISTING_MODEL_VOLUME
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode deploy
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode verify-schema
```

Inspect `--help` for explicit image choices. Deployment applies only the already approved migration chain to this new test database; it never generates a migration or uses `db:push`. Bucket initialization requires a fresh private, empty, unversioned bucket and rejects successful anonymous listing.

Start the API in its own foreground terminal:

```sh
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode app --service api
```

Then seed the synthetic fixture from another terminal:

```sh
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode seed
```

Bootstrap creates the accounts/organizations through native authentication operations. One narrowly scoped isolated transaction adds the fixture's restricted reader membership after verifying the exact empty baseline. This setup is not proof of a dashboard membership flow. No corpus documents, collections, vectors, grants, keys or superadmins are seeded.

Start workers in another foreground terminal, then ready the fixture and run the collector:

```sh
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode app --service workers
```

```sh
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode ready
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode collect
```

Keep unrelated dashboard/search activity out of the collector phase. It performs normal uploads, full library canonical previews, saved EN/FR/tags/typed metadata, native probes and index admission. Direct database observations are separately guarded read-only saved-generation/configuration/publication checks; they never seed business rows or force task progress.

Each of 72 unscored, fixed top 1 lexical source probes supplies a fresh exact-version receipt. The collector verifies all returned source segments and hashes the original download immediately, discarding the receipt and bytes. Canonical evidence is truthfully labeled **full library-current-v1 preview plus exact indexed publication and returned indexed source segments**. Gaps between indexed segments are not fabricated as receipt-returned text. The subsequent 720 query cells and 12 reader/foreign/revoked/old-receipt controls use actual normal requests and transport-observed statuses.

After collection, optionally start `app --service web` and verify matched children/parents, filters, source downloads and localized permission/error states in the dashboard. Runtime-only guarded commands intentionally operate on their declared private fixture; pure tests do not invoke these commands.

## Captures, failures and cleanup

Private state and `fixture.json` live under `node_modules/.cache/vectorix/vectorix-m7c-quality-RUN/`. They include synthetic credentials and must remain outside Git. Process/resource identities are checked against actual IDs, creation records, PID/boot/start ticks, environments and pinned source/build hashes. Unknown identity or partial setup stops automatic progression.

The collector allows up to 90 minutes overall, 20 minutes per extraction/index wait, 6,000 RAG RPCs, 40 seconds per request and 2 MiB actual decoded response bytes. Captures are capped at 8 MiB, 2,048 deduplicated passages, the top 10 results and 64 projected source spans. Signed receipts, auth cookies/tokens/passwords, vectors, raw provider errors and unexpected returned text never enter reports. Only confirmed artificial canonical content can enter a private capture. Client abort does not prove cancellation of accepted server/provider work.

Existing captures are never overwritten or resumed by repeating uploads. Keep incomplete evidence and inspect the finite safe diagnostic; do not rewrite leases, dates, counters, statuses, source hashes or task outcomes. A completed child exit alone cannot substitute for the supervisor's exact run/result/count checks. Sign-out uses the normal authentication path.

Offline rescoring reads an existing bounded private capture and creates a new report exclusively with mode `0600`:

```sh
node tests/acceptance/quality/score.mjs --capture /absolute/private/capture.json --report /absolute/private/new-quality-report.json
```

`score.mjs` makes no service calls and refuses input/output equality or an existing output. The evaluator verifies recorded proof consistency; JSON flags/hashes alone cannot establish that HTTP or native work actually occurred.

Clean only this run's recorded resources after dashboard verification:

```sh
python3 -B tests/acceptance/quality/quality-topology.py --run "$quality_run" --mode cleanup
```

Cleanup checks exact owned IDs/labels/volume creation identities and stops the owned foreground apps. It preserves the supplied model volume and private evidence. A failed graceful stop or ambiguous resource remains a refusal requiring investigation; there is no forced deletion by name or restoration-state bypass.

## Helper map and evidence boundary

- `quality-topology.py` / `quality_topology_policy.py`: explicit owned lifecycle, immutable source/build pins, exact resource/environment validation and cleanup; reuse only the existing restore common primitives.
- `quality-bootstrap*.mjs`, `quality-bucket.mjs`: bounded fixture and private-bucket setup, guarded before actual clients/imports.
- `collector.mjs`, `collector-state.mjs`, `collector-guard.py`, `collector-runtime.mjs`, `collector-protocol.mjs`: independent resource/tenant guard, normal authenticated actions, safe checkpoints and read-only saved-generation observations.
- `evaluate.mjs`, `fixture-loader.mjs`, `score.mjs`: bounded offline scoring. `queries.mjs`, `build-sources.py`, `prepare.mts` and `workspace-root.mjs` support portable local regeneration.
- `helper-provenance.json`: `nativeArchivedHelpersSha256` is the 14-entry retained native-run manifest, including the shared restore alias; `preRelocationSourceSha256` and `relocatedHelpersSha256` compare the broader set of 25 helper, test and generator sources. The 56 frozen-file hashes separately cover the corpus. This is a consistency manifest, not a signature or independent runtime attestation.

No live capture, credentials, prepared synthetic report/capture, load helper, latency observer or unused design draft is included. Historical native success belongs to the exact archived run and product commit stated above; post-relocation validation covers local tests/parsers only. A future native run must create a fresh namespace and record its own actual product/helper/image/model identities.
