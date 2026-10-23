# Conditional semantic interruption fixture

This directory prepares one deliberately artificial UTF-8 TXT document for a future, separately owned semantic-boundary interruption trial. It runs local production extraction, preparation and planning functions. The preflight does not start an application, worker, database, container or model, send an HTTP request, or inject a fault.

The source alternates English and French prose across 128 long, distinct paragraphs. It has no sentence-ending punctuation within a paragraph, so the production unitizer can retain each paragraph as one semantic unit under the declared preparation contract. These artificial statements are neither reference answers nor a retrieval-quality corpus. They do not modify the frozen M7c reference corpus.

## Files and reproducibility

- `fixture.mjs` deterministically generates the source; `preflight.mjs` invokes the actual worker plain-text extraction and shared production functions.
- `fixture.test.mjs` contains seven local tests. It uses only synthetic strings and owned temporary files.
- `prepared-v1/m7c-semantic-boundary-128-v1.txt` is the exact upload file. Keep this filename: production uses the uploaded filename as the EmbeddingGemma document title.
- `prepared-v1/canonical.json` records the actual locally extracted artifact. Offsets are UTF-16 code units; text and input hashes use UTF-8 SHA-256.
- `prepared-v1/preflight.json` binds the source, canonical artifact, unit ranges, all prepared unit inputs, six illustrative plans, production sources and the two fixture source modules.

From the repository root, run the existing-file check and tests:

```sh
pnpm --filter api exec node --import tsx ../../tests/acceptance/interruption/fixture/preflight.mjs check
pnpm --filter api exec node --import tsx ../../tests/acceptance/interruption/fixture/fixture.test.mjs
```

`preflight.mjs generate` creates `prepared-v1/` once with directory mode `0700`, exclusive files with mode `0600`, and `fsync`. It refuses an existing directory. The normal `check` command regenerates in memory and compares all three files byte for byte; it does not overwrite them. A change to a recorded production or generator source causes the bound proof check to fail and requires an explicit new preparation review; the six recorded production files do not replace the future topology's full product/build pins. Prepared public files also accept Git checkout modes `0644` and directory mode `0755`; private probe files still require `0600`. File checks reject symlinks, unexpected files, wrong ownership/modes and excessive actual bytes read. CLI failures expose one finite diagnostic.

## Actual local result

The seven relocated tests and the `generate`/`check` commands passed locally. They made no native calls. The original ignored helper had six tests; the seventh covers public checkout modes without relaxing private probe files.

| Measurement                                   | Observed local value                                                          |
| --------------------------------------------- | ----------------------------------------------------------------------------- |
| Original source size                          | 233,383 bytes, below the 25 MiB upload limit                                  |
| Exact canonical length                        | 228,671 UTF-16 code units                                                     |
| Useful semantic units                         | 128, with distinct text and prepared-input hashes                             |
| Preparation contract                          | EmbeddingGemma preset, 2,048 context units, exact filename, empty preparation |
| Useful text byte cap                          | 1,968, derived by production `embeddingInputByteLimit`                        |
| Maximum unit text / prepared input            | 1,824 / 1,872 bytes                                                           |
| Total boundary prepared inputs                | 239,272 bytes                                                                 |
| Profile                                       | Target 512, minimum 128, maximum 768, overlap 64; parent maximum 2,048        |
| Synthetic geometry                            | Percentiles 90 and 55 with zero, tied positive and varied synthetic distances |
| Synthetic child / parent range                | 174–255 children / 43–44 parents; parents are not embedded                    |
| Native boundary distances                     | Unknown                                                                       |
| Relocated native execution and fault recovery | `NATIVE_RETEST_NOT_RUN`                                                       |
| Native duration                               | Unmeasured                                                                    |

The source and canonical text SHA-256 are both `9362fe4019bef7c9c744a4ba46a599523fa693b951103888e4ec1737a7227dd6`. The original native-run `preflight.json` SHA-256 was `879e7fc71b2074052ac978965b83bda7e2322522d89a58d70e4cd2e79d2b3c05`. Its original file remains in private archived evidence; it was not overwritten by relocation. The regenerated tracked proof has different generator-source hashes and is separate local evidence; its current SHA-256 is `36b67fe4dba20f726cda48b8e5fd9f1ed245c49fd26865bb18dada72598de321`.

The six score arrays are explicitly synthetic. They establish that representative geometry can pass the production validators and byte limits; they do not predict the native model's distances, final boundaries, runtime, cost or bill. Every actual native child input must still pass the saved model's production preparation checks.

## Native provenance and future admission

The byte-identical source and canonical artifact were used with the ignored helpers in native run `8af698331852` on product commit `810fe339724254dee66896bc276a8415a3785915`. That run has an explicit formal observer result `INCOMPLETE` and separate supplemental catalog, physical and dashboard recovery observations. It must not be described as a formal observer PASS. The tracked preflight was regenerated after relocation and public-checkout support; it has not run the native trial (`NATIVE_RETEST_NOT_RUN`). See the parent interruption README and provenance manifest for the distinct original and relocated source hashes. No private run captures, checkpoints or credentials are included here.

### Admission for a new trial

The number 2,048 is an explicit local preparation contract. The preparation contract alone is not a recovered native snapshot, a fresh provider probe, a tokenizer measurement or a verified weight identity. A useful-input cap of 6,144 is not asserted here.

Before any model work, obtain a fresh, guarded probe of the current saved Ollama profile in a newly enrolled, disposable topology. Require the Ollama provider, `embeddinggemma:latest`, the explicit EmbeddingGemma preset, a verified current native digest, a supported selected dimension and a preparation cap that preserves all 128 units. Keep the exact upload filename and empty preparation. Confirm the current generation/profile/source bindings separately; a compatible JSON file alone grants no authority to run a trial.

For an additional local compatibility check, export only public probe metadata into an owned `0600` JSON file under the repository's `node_modules/.cache/vectorix/` directory:

```json
{
    "provider": "OLLAMA",
    "model": "embeddinggemma:latest",
    "digest": "<the current verified 64-hex native digest>",
    "contextTokens": 2048,
    "preset": "EMBEDDING_GEMMA",
    "dimensions": 128
}
```

```sh
pnpm --filter api exec node --import tsx ../../tests/acceptance/interruption/fixture/preflight.mjs check-probe /absolute/path/inside/node_modules/.cache/vectorix/fresh-probe.json
```

The command recalculates the production unitization and input preparation against that metadata. Its output says `NOT_PROBED_BY_THIS_TOOL`; it cannot establish the origin, freshness or current authorization of the supplied JSON. A smaller incompatible context, another preset/provider, malformed digest or unsupported dimension refuses the check.

## Future dashboard trial boundary

After the independent fault and recovery helpers are reviewed and admitted, use normal dashboard upload, collection setup and indexing. One collection may first serve generation A, then accept semantic candidate B with a percentile change from 90 to 55. The intended fault is a single interruption during B's boundary planning, after a durable nonempty partial prefix and before completion.

The observed `caught.completedUnits` is authoritative; 32 is a useful expected continuation checkpoint rather than a fixture guarantee. Neither 128 units nor this CPU-only preflight proves that an operator will catch that window within 15 minutes. Require the real lease to expire naturally, then observe a new owned worker and reconcile durable plans, accounting, source holds and publication. This fixture does not enable the fault adapters or confer the separately recorded native recovery results on a future run.
