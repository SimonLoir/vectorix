# Deterministic chunk planning

`@repo/chunking` plans bounded canonical text ranges from a retained, validated extraction artifact. Embedding execution, persistence, quotas and authorization belong to callers. A planner alone does not establish a completed dashboard journey.

| Strategy             | Saved version          | Behavior                                                                      |
| -------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `DOCUMENT_STRUCTURE` | `structure-utf8-v1`    | Preserves existing page, section, story and Markdown-heading grouping.        |
| `TOKEN_WINDOW`       | `token-window-utf8-v1` | Uses contiguous canonical text windows; structural boundaries may be crossed. |

Resolve the strategy before accessing credentials, source objects or providers:

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
