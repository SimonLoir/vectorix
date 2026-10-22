# Structure-aware chunk planning

`@repo/chunking` plans deterministic canonical text ranges from a retained extraction artifact. M3 implements document structure only. Embedding execution, metadata persistence, quotas and authorization belong to callers. Future strategies remain gated until their complete dashboard journeys are implemented.

PDF pages, DOCX headings/sections/story parts and Markdown headings are strong boundaries. Smaller paragraphs may combine within the same structural group; oversized groups split at bounded text/word positions. These preferences can produce a short chunk at a structural boundary. Every chunk retains immutable extraction source spans and the exact original text; embedding preparation must never replace that authoritative text.

`tokenCount` is explicitly an estimate based on UTF-8 bytes. The independent `maxEmbeddingInputBytes` cap must be computed from the verified provider context after preset/preparation overhead. It takes precedence over requested approximate token sizes. Embeddings must disable silent truncation and fail explicitly if the native provider still rejects the input. This is not a claim of exact model tokenization.

The planner is a bounded generator. Callers finish a bounded plan before accepting quota or writing chunks; exceeding `maxChunks` throws rather than publishing a partial document. Retries with the same artifact/profile/chunker version produce the same text and source positions. Tests cover Unicode coverage, structural provenance, model bounds, overlap amplification and deterministic retries.
