# Native embeddings

`@repo/embeddings` currently implements native Ollama discovery, capability verification, and bounded document/query embedding. Other catalog providers remain planned adapters. The package accepts a complete resolved `{ provider: 'OLLAMA', endpoint, apiKey }` configuration. It never reads environment variables, chooses organization credentials, downloads models, or accesses application databases.

The RAG layer resolves credentials and enforces exact operator-approved endpoints in [`embedding-profile.ts`](../routers/rag/src/services/indexing/embedding-profile.ts). Saved collection revisions retain their credential and destination binding. An invalid configured binding must fail; it must not fall back to platform defaults.

## Entry points

- `discoverModels(config, options?)` returns installed canonical model names, manifest digests, and families. Discovery is bounded to 512 models.
- `verifyEmbeddingModel(config, { model, dimensions, preset, preparation? }, options?)` checks native embedding capabilities, context length, architecture, family, default dimensions, and actual finite nonzero probe vectors. Arbitrary dimension reduction is rejected. The original 300M EmbeddingGemma model supports the documented 768, 512, 256, and 128 dimensions; the selected choice is probed through the native API.
- `embedDocuments(config, identity, [{ text, title? }], options?)` and `embedQuery(config, identity, text, options?)` use an immutable verified identity, explicit preparation, `truncate: false`, and native `/api/embed` requests.
- `embeddingInputByteLimit(identity, { kind?, title?, preparation? })` supplies the conservative content byte budget used by chunking. `prepareEmbeddingInput` applies the same accounting at the provider boundary.

`GENERIC` sends raw text with no inferred model prefix. `EMBEDDING_GEMMA` applies Google's original EmbeddingGemma retrieval prompts to document and query inputs. Document titles are normalized and truncated at a valid UTF-8 boundary to 200 bytes; a missing title becomes `none`. Optional preparation is a literal prefix followed by a newline on both roles. It is never interpreted as a template.

The complete input, including preparation, title, and preset prefix, must fit within the context-token count minus 32 bytes, capped at 64 KiB. This deliberately conservative byte bound avoids assuming a tokenizer. Native `truncate: false` still rejects inputs the model cannot encode.

## Identity and failure boundaries

Every embedding batch checks the installed manifest digest before and after the native request. A normal model replacement fails with `MODEL_CHANGED`; a generation must not combine outputs from different saved identities. Ollama's native embedding response contains a model name and no cryptographic digest. These checks cannot detect a malicious or extremely fast A→B→A replacement between observations. Deploy trusted, stable Ollama services; the manifest check is an observable consistency guard, not remote attestation.

One operation deadline covers discovery, probes, all batches, retries, and manifest checks. Request JSON is bounded to 2 MiB, response JSON to 8 MiB and 16 nesting levels. Embedding requests contain at most 128 inputs and additionally bound request bytes and expected vector-response size. HTTP 429 and 5xx responses receive at most three attempts with bounded backoff. Redirects fail closed. Errors expose only stable domain codes, never URLs, credentials, response bodies, or original exceptions.

Usage contains aggregate provider `prompt_eval_count` as `providerInputTokens` (or `null` when unavailable), a separate `estimatedInputTokens` value computed from prepared UTF-8 bytes, and successful embedding request count. The estimate must never be presented as an exact tokenizer count or provider billing.

## Validation

The [Ollama and EmbeddingGemma reproduction guide](../../docs/rag-ollama-embeddinggemma.md) provides the tested CPU container/version, model digest, installation and native probe commands, credential/network configuration, dashboard recipe and actual live evidence.

Run `pnpm --filter @repo/embeddings test` for local HTTP fixtures covering native requests, authorization, ordering, batching, usage, invalid vectors, model replacement, retries, cancellation, response limits, redirects, and input preparation.

For a live check, create a disposable official CPU-only Ollama container, install `embeddinggemma`, then run from this directory:

```sh
node --import tsx tests/live.mts http://127.0.0.1:PORT
```

The live script accepts only an explicit loopback endpoint, never reads `.env`, verifies all four dimensions, and checks French query retrieval against French/English documents. It does not establish a dashboard acceptance test; the product milestone must record that separately.

## Primary references

- [Ollama native embedding API](https://docs.ollama.com/api/embed): request dimensions, input batches, truncation, and provider input-token usage.
- [Ollama installed model API](https://docs.ollama.com/api/tags) and [show API source documentation](https://github.com/ollama/ollama/blob/main/docs/api.md#show-model-information): model manifests and capability metadata.
- [Google's original EmbeddingGemma 300M model card](https://huggingface.co/google/embeddinggemma-300m): retrieval query/document prompts, 2048-token context, and Matryoshka dimension choices.
- [Official Ollama Docker setup](https://docs.ollama.com/docker): CPU container execution.
