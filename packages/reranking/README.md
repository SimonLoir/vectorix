# Reranking adapters

`@repo/reranking` supports native Cohere, Voyage and self-hosted Hugging Face Text
Embeddings Inference (TEI) reranking. Hosted operations make one POST; TEI makes
one metadata GET and one inference POST under one shared deadline.
It is an optional ranking primitive: callers authorize candidate content, resolve
saved credentials, allowlist the destination, and admit provider work through the
final `beforeInference` callback. The package does not retrieve documents, retry requests, fall back to
another provider, or attest hosted model weights or ranking quality.

```ts
import { rerank, validateRerankingInput } from '@repo/reranking';

const input = {
    model: 'rerank-v5.0-fast',
    query: 'Which plants tolerate shade?',
    documents: ['Ferns grow in shade.', 'Lavender needs sun.'],
};
const statistics = validateRerankingInput('COHERE', input);
// Authorize candidates first; recheck them and persist dispatch intent at the final boundary.
const result = await rerank(configuration, input, {
    timeoutMs: 15000,
    signal,
    beforeInference: async () => {
        await recheckCurrentAuthority();
        await admitDispatch(statistics);
    },
});
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
Unknown hosted model names fail before HTTP. TEI entries are suggestions:
`BAAI/bge-reranker-v2-m3` and `Alibaba-NLP/gte-multilingual-reranker-base`, both with
published 8,192-token tokenizer/context limits. Bounded custom TEI model or
deployment labels are accepted only when they match the native endpoint metadata.
`isRerankingModelId`, `supportsRerankingModel`, and `rerankingScoreKind` are also
dependency-free browser exports. Score kinds distinguish `provider_relevance`
from TEI `normalized_cross_encoder`; normalized scores are not calibrated
probabilities or a common confidence scale across models.

## Native protocols and usage

Configuration is `{ provider: 'COHERE' | 'VOYAGE', endpoint, apiKey }`. The endpoint
must be an HTTP(S) root URL without credentials, path, query, or fragment, matching
the corresponding embedding configuration convention. Destination allowlisting
remains the caller's responsibility.

### Self-hosted TEI

TEI configuration uses `{ provider: 'TEI', endpoint, apiKey?, runtimeSnapshot }`.
The optional key may be null or omitted; no Authorization header is sent in that
case. An explicitly invalid key is rejected rather than treated as absent. A
configured key is sent as Bearer authorization for both native requests.

```ts
import { probeTei, parseTeiRuntimeSnapshot, rerank } from '@repo/reranking';

const connection = { provider: 'TEI' as const, endpoint, apiKey: null };
// Authorize and allowlist the destination first. No inference occurs here.
const runtimeSnapshot = await probeTei(connection, {
    model: 'BAAI/bge-reranker-v2-m3',
    candidatePool: 32,
});
// Save this immutable snapshot with the profile, after rechecking authority and
// credential/CAS bindings. Read saved JSON with the sanitized parser.
const saved = parseTeiRuntimeSnapshot(runtimeSnapshot);
const result = await rerank(
    { ...connection, runtimeSnapshot: saved },
    { model: saved.modelId, query, documents },
    { signal, timeoutMs: 15000 }
);
```

`probeTei` performs only bounded `GET /info`, validates a compatible single-label
reranker and the requested pool, and returns a frozen `TeiRuntimeSnapshot`:
`protocolVersion: 'native-tei-v1'`, `modelId`, nullable `modelRevision`,
`modelType: 'reranker'`, `maxInputLength`, `maxClientBatchSize`, `runtimeVersion`,
and `modelDtype`. Invalid saved JSON never exposes parser diagnostics.

Before any GET, `rerank` validates the complete input, saved snapshot, model and
saved batch limit. It then compares live `/info` identity, reported revision,
dtype, runtime version and limits against that exact snapshot. Any mismatch
requires a new profile; no POST is sent. TEI serves one model per endpoint, so the
POST has no model selector. It sends `/rerank` with `query`, `texts`,
`truncate: false`, `raw_scores: false`, and `return_text: false`; its native result
is the complete array of `{index, score}` rows. Returned document text is ignored.

TEI defaults to a maximum client batch of 32. Set the collection pool accordingly
or raise the operator's runtime limit; the adapter never splits the request or
silently drops candidates. Byte limits do not prove token fit for a particular
tokenizer. An overlong pair remains a provider refusal, without silent truncation.
Both requests share one deadline of at most 15 seconds, including streamed bodies.
The live `/info.max_concurrent_requests` must also be a bounded positive integer
at least as large as the candidate pool, because TEI acquires one inference permit
per pair. This current capacity check does not rewrite the reported client-batch
limit or add an immutable model-identity field. Other simultaneous requests can
still exhaust permits and produce an explicit provider overload refusal.

The optional `beforeInference` callback runs after the matching live metadata GET
and immediately before candidate text is posted; hosted adapters run it immediately
before their POST. Recheck current grants, sources, profile, credentials and endpoint
policy here, and only then persist dispatch intent. Metadata failure never invokes
the callback. Its errors propagate unchanged as caller errors, and cancellation or
deadline expiry before or during it prevents the POST. The callback must bound its
own asynchronous work; it cannot renew the native deadline. Metadata-only `probeTei`
does not invoke this inference hook.

These are endpoint-reported capabilities, not verified weight bytes. In TEI 1.9,
`model_sha` reflects the launch `--revision` argument and can be null, `main`, or a
commit label. Pin the model revision and container image for reproducibility and
avoid mixing different models behind one endpoint. Metadata equality cannot
attest model weights or rule out a deployment change between requests.

TEI's optional validated `x-compute-tokens` response header becomes
`providerInputTokens`. Missing counts remain null and explicit zero stays zero;
malformed supplied counters reject the response. Billing fields stay null.

The native protocol and metadata follow the pinned official
[TEI 1.9 HTTP types](https://github.com/huggingface/text-embeddings-inference/blob/v1.9.0/router/src/http/types.rs),
[rerank implementation](https://github.com/huggingface/text-embeddings-inference/blob/v1.9.0/router/src/http/server.rs),
[reported identity and usage headers](https://github.com/huggingface/text-embeddings-inference/blob/v1.9.0/router/src/lib.rs),
and [runtime configuration](https://github.com/huggingface/text-embeddings-inference).
The runtime uses Apache-2.0; the upstream
[BGE model card](https://huggingface.co/BAAI/bge-reranker-v2-m3) and
[GTE model card](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base)
also declare Apache-2.0. The BGE limit comes from its
[tokenizer configuration](https://huggingface.co/BAAI/bge-reranker-v2-m3/blob/main/tokenizer_config.json).
These declarations do not establish performance, deployment compatibility or
retrieval quality on a particular instance. TEI remains a separate native
provider; it does not emulate Cohere or use Ollama embeddings as rerank scores.

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

One operation shares a deadline of at most 15,000 ms across headers and entire bodies.
An external abort signal can shorten it. The actual streamed response is capped
at 256 KiB, with bounded JSON nesting and strict UTF-8 decoding. Redirects, HTTP
errors, and malformed/partial responses fail closed; there are no automatic
retries or fallback requests, including for 429 or 5xx responses.

`RerankingError` exposes only a fixed code and message, with no provider response,
credential, endpoint, input text, or original cause. Its codes are
`INVALID_CONFIGURATION`, `MODEL_UNSUPPORTED`, `INPUT_TOO_LARGE`,
`MODEL_CHANGED`,
`PROVIDER_UNAVAILABLE`, `PROVIDER_TIMEOUT`, `PROVIDER_REJECTED`, and
`INVALID_PROVIDER_RESPONSE`. Cancellation uses `PROVIDER_TIMEOUT`, consistent
with the embedding boundary. Callers decide how to present failures and preserve
the original search results when optional reranking is unavailable.

## Validation

Run `pnpm --filter @repo/reranking test`, `pnpm --filter @repo/reranking check-types`,
and `pnpm --filter @repo/reranking lint`. Tests own local HTTP servers and exercise
all three native DTOs, saved/live TEI metadata, optional authentication, full cardinality, usage separation, byte limits, streamed-body
bounds, deadlines, external cancellation, redirects, and the absence of retries.
They make no real provider calls and establish no hosted quality or billing claim.
