# Reranking adapters

`@repo/reranking` makes one bounded native reranking request to Cohere or Voyage.
It is an optional ranking primitive: callers authorize candidate content, resolve
saved credentials, allowlist the destination, and admit provider work before
calling it. The package does not retrieve documents, retry requests, fall back to
another provider, or attest hosted model weights or ranking quality.

```ts
import { rerank, validateRerankingInput } from '@repo/reranking';

const input = {
    model: 'rerank-v5.0-fast',
    query: 'Which plants tolerate shade?',
    documents: ['Ferns grow in shade.', 'Lavender needs sun.'],
};
const statistics = validateRerankingInput('COHERE', input);
// Authorize the candidates and admit the operation using these bounded statistics.
const result = await rerank(configuration, input, { timeoutMs: 15000, signal });
```

The pure validator returns `candidateCount`, `preparedInputBytes`, and
`serializedRequestBytes`. `preparedInputBytes` is the UTF-8 query size multiplied
by the candidate count, plus all document sizes. All input and exact serialized
native-body checks run before it returns. `rerank` repeats them and snapshots the
request so a later mutation cannot alter its model or candidate count.

The dependency-free `@repo/reranking/models` subpath is safe for browser imports.
It exports the frozen `RERANKING_MODELS` catalog, `RERANKING_LIMITS`,
`listRerankingModels`, and the `RerankingProvider` and `RerankingModel` types. The
catalog contains Cohere `rerank-v5.0-fast` and `rerank-v5.0-pro`, and Voyage
`rerank-3` and `rerank-3-lite`, each with a published 32,000-token context cap.
Unknown model names fail before HTTP.

## Native protocols and usage

Configuration is `{ provider: 'COHERE' | 'VOYAGE', endpoint, apiKey }`. The endpoint
must be an HTTP(S) root URL without credentials, path, query, or fragment, matching
the corresponding embedding configuration convention. Destination allowlisting
remains the caller's responsibility.

- Cohere appends `/v2/rerank`, requests every candidate through `top_n`, and sets
  `max_tokens_per_doc: 24000`. It reads `results[].index/relevance_score`.
- Voyage appends `/v1/rerank`, sets `top_k` to the candidate count,
  `return_documents: false`, and `truncation: false`. It reads
  `data[].index/relevance_score` and verifies the returned model.

Every response must contain each input index exactly once, with finite scores
between zero and one. Missing, duplicate, additional, or invalid indices reject
the entire response. Results are sorted by descending score and then ascending
input index, including ties.

`usage.providerInputTokens` reads Cohere `meta.tokens.input_tokens` or Voyage
`usage.total_tokens`. Cohere `meta.billed_units.input_tokens` and `search_units`
remain separate as `billedInputTokens` and `billedSearchUnits`. These fields are
nullable; omission is not zero. Explicit zero remains zero. Voyage does not
synthesize billed units from its token observation. Malformed supplied usage
rejects the response.

These DTOs and catalog entries follow the official
[Cohere API reference](https://docs.cohere.com/reference/rerank),
[Cohere model catalog](https://docs.cohere.com/docs/models),
[Cohere metadata example](https://docs.cohere.com/v2/docs/rerank-overview),
[Voyage API reference](https://docs.voyageai.com/reference/reranker-api), and
[Voyage model guide](https://docs.voyageai.com/docs/reranker).

## Bounds and failures

An operation accepts 1–100 candidates, a nonempty query of at most 4,000 UTF-8
bytes, and documents of at most 20,000 bytes each. The repeated-query input budget
is 512,000 bytes. This is a conservative token upper bound for admission, not a
provider token count. A query/document pair is at most 24,000 bytes, below the
reviewed 32,000-token context. Text is preserved without silent truncation.
Serialized JSON is separately capped at 2 MiB, including escaping overhead.

One POST shares a deadline of at most 15,000 ms across headers and the entire body.
An external abort signal can shorten it. The actual streamed response is capped
at 256 KiB, with bounded JSON nesting and strict UTF-8 decoding. Redirects, HTTP
errors, and malformed/partial responses fail closed; there are no automatic
retries or fallback requests, including for 429 or 5xx responses.

`RerankingError` exposes only a fixed code and message, with no provider response,
credential, endpoint, input text, or original cause. Its codes are
`INVALID_CONFIGURATION`, `MODEL_UNSUPPORTED`, `INPUT_TOO_LARGE`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_REJECTED`, and
`INVALID_PROVIDER_RESPONSE`. Cancellation uses `PROVIDER_TIMEOUT`, consistent
with the embedding boundary. Callers decide how to present failures and preserve
the original search results when optional reranking is unavailable.

## Validation

Run `pnpm --filter @repo/reranking test`, `pnpm --filter @repo/reranking check-types`,
and `pnpm --filter @repo/reranking lint`. Tests own local HTTP servers and exercise
both native DTOs, full cardinality, usage separation, byte limits, streamed-body
bounds, deadlines, external cancellation, redirects, and the absence of retries.
They make no real provider calls and establish no hosted quality or billing claim.
