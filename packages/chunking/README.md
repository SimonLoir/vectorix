# Deterministic chunk planning

`@repo/chunking` plans bounded canonical text ranges from a retained, validated extraction artifact. Embedding execution, persistence, quotas and authorization belong to callers. A planner alone does not establish a completed dashboard journey.

| Strategy             | Saved version          | Behavior                                                                      |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `DOCUMENT_STRUCTURE` | `structure-utf8-v1`    | Preserves existing page, section, story and Markdown-heading grouping.        |
| `TOKEN_WINDOW`       | `token-window-utf8-v1` | Uses contiguous canonical text windows; structural boundaries may be crossed. |

Pure semantic helpers are also available under `semantic-utf8-v1`. They require external durable embedding/checkpoint orchestration and are deliberately absent from the synchronous resolver. Their availability alone does not establish a completed semantic dashboard journey.

Resolve the synchronous strategy before accessing credentials, source objects or providers:

```ts
import { resolveChunkingStrategy } from '@repo/chunking';

// Admission: persist this version with the immutable generation.
const current = resolveChunkingStrategy(profile.chunkingStrategy);

// Replay: invalid strategy/version pairs throw before source or provider I/O.
const saved = resolveChunkingStrategy(
    profile.chunkingStrategy,
    generation.chunkerVersion
);
const chunks = [
    ...saved.plan(artifact, {
        ...profile.chunking,
        maxEmbeddingInputBytes,
    }),
];
```

Unknown strategies, unknown versions and mismatched pairs synchronously throw `INVALID_CHUNK_PROFILE`. Finish the entire bounded plan before accepting quota, persisting chunks or calling an embedding provider. Generators can throw `CHUNK_LIMIT` after earlier yields; those yields are not an accepted partial document. Identical artifacts, profiles and versions produce identical text and source positions. Direct `chunkDocumentStructure` and `chunkTokenWindow` exports remain available for callers that already chose the exact version.

## Byte estimates and context limits

`tokenCount` is `ceil(UTF-8 bytes / 3)` and always carries `tokenCountIsEstimate: true`. This is not a model tokenizer. `maxEmbeddingInputBytes` must come from the verified provider context after preparation/title overhead. It takes precedence over requested approximate token sizes. Providers must disable silent truncation and fail explicitly if they still reject an input.

Profiles require safe integers: `1 <= minTokens <= targetTokens <= maxTokens <= 16,384`, target and maximum at least 32, `0 <= overlapTokens < targetTokens`, `32 <= maxEmbeddingInputBytes <= 49,152`, and optional `1 <= maxChunks <= 100,000`.

## Token-window policy

The target is `targetTokens * 3` bytes, clamped to both `maxTokens * 3` and the verified input byte limit. Overlap is a suffix of at most `overlapTokens * 3` bytes, clamped below the effective target so windows advance. Cuts never split a valid UTF-16 surrogate pair. They do not normalize text, preserve grapheme clusters, or guarantee word/sentence boundaries.

`minTokens` only controls final-tail coalescing: a remaining suffix shorter than `minTokens * 3` bytes joins the current window when the combined window fits both maximum and model limits. Otherwise a useful short tail remains a separate chunk, even below the minimum. Leading/trailing window whitespace is trimmed using canonical offsets. As with the existing structure planner, windows without a Unicode letter or number are omitted, including pure punctuation/emoji windows; symbols inside a useful window remain unchanged. This is not a full-symbol search guarantee.

Every attempted token window counts toward `maxChunks`, independently of how many useful chunks were emitted. Whitespace, punctuation and high overlap therefore cannot evade the work bound. Up to the extraction artifact's 5,000 sources are retained internally, each clipped to the exact chunk intersection; an oversized source list fails with `CHUNK_LIMIT`. Token windows never assign one source's heading to the whole chunk. The API separately bounds its source projection to the first 64 spans and reports truncation.

## Structure policy and provenance

PDF pages, DOCX headings/sections/story parts and Markdown headings remain strong boundaries for `structure-utf8-v1`. Smaller paragraphs may combine within the same group; oversized groups split at bounded text/word positions. These preferences can produce a short chunk at a structural boundary. Its implementation and saved replay behavior are unchanged by the token-window strategy.

Both planners retain exact original text and immutable extraction source spans. Embedding preparation must never replace that authoritative text, and planning never dereferences source relationships. Run `pnpm --filter @repo/chunking test` for version/replay checks, Unicode and provenance coverage, tail policy, context limits and bounded overlap/empty-window behavior.

## Pure semantic planning

`unitizeSemantic(artifact, {maxEmbeddingInputBytes, maxUnits?})` returns ordered `{ordinal, start, end}` records. `semantic-units-utf8-v1` uses a fixed scanner rather than `Intl.Segmenter`: ASCII `.`, `!`, `?` followed by whitespace/end (including closing quotes/brackets), CJK `。！？`, and blank lines containing only ASCII space/tab/CR. It makes no linguistic abbreviation or ICU-version claim. Long segments split at safe surrogate boundaries under the verified input-byte budget after title/preparation overhead. Outer whitespace is excluded; meaningful units contain a Unicode letter or number. Canonical text is neither normalized nor rewritten, and gaps between units remain available to final chunks.

The complete array must exist before spending provider cost. A document has at most 8,192 useful units, and callers may lower `maxUnits`. Independently, at most `2 * maxUnits` candidate segment/windows may be attempted, including omitted punctuation/whitespace. Validated source artifacts retain their existing 25 Mi UTF-16-code-unit and 5,000-source bounds. Final chunk planning additionally has the existing 100,000-attempt limit and must be exhausted before accepting any partial output.

`semanticUnitManifestHash` binds the exact JSON-serialized canonical text, both algorithm versions, verified byte cap and ordered ranges. `validateSemanticUnits` replays that deterministic unitization once per claim and rejects a mismatched hash or geometry. `assertSemanticVersions` rejects unsupported saved versions before external I/O. Callers must separately bind the immutable source/extraction, configuration, provider identity and credential revision; these helpers do not assert model weights or replace those authorization checks.

Use `quantizeSemanticVector` before distance computation and checkpointing. It converts every component with `Math.fround`, rejects nonfinite/overflowed components, empty/oversized vectors and zero norms, and retains valid float32 subnormals. Checkpoints must serialize the resulting last vector as explicit little-endian float32 bytes. `quantizedAdjacentDistance` applies that same conversion, computes cosine distance in `[0, 2]`, then rounds to an integer in `[0, 2,000,000]`. A restored checkpoint therefore produces the same adjacent score as the uninterrupted calculation.

`semanticThreshold(scores, percentile)` uses nearest rank: `ceil(n * percentile / 100) - 1`, clamped to the sorted array. A boundary qualifies when its score is **positive and at least the threshold**. Ties can qualify together; the 90th percentile does not promise exactly 10% of boundaries. Empty scores have no threshold; all-zero scores yield no eligible semantic boundary.

`chunkDocumentSemantic(artifact, options, {units, distances, unitManifestHash})` validates the complete state before yielding. For each window it prefers the last eligible boundary at/above the effective minimum and before the target; otherwise the first eligible boundary after target within the hard maximum; otherwise a safe target cut. The verified model cap always wins. A short final suffix may coalesce only within hard caps, while useful short tails remain. Overlap is bounded and advances. Every intersecting source span is clipped exactly, without assigning one source's heading to the whole chunk.

Seal the final `{ordinal, start, end}` array with `semanticPlanHash(state, options, ranges)`, which binds all distances, the unit manifest, execution settings and final ranges. `validateSemanticPlan` reconstructs and compares the canonical plan once per claim. Orchestration owns immutable sealing, cost reservations, idempotent provider batches, database publication and retries; none of these pure functions performs provider, database or object I/O. Corrupt semantic state raises only `SemanticStateError` with `INVALID_SEMANTIC_STATE`; invalid profiles and bounded-work exhaustion retain `INVALID_CHUNK_PROFILE` and `CHUNK_LIMIT`.
