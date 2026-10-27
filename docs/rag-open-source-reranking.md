# Self-hosted open-source reranking

Status: implemented, with additive migration/integration checks and a real TEI/GTE CPU dashboard journey verified at checkpoint `f13923bf` in run `781ec6094ad2`. This establishes the functional journey, not ranking quality or capacity. Hosted-provider quality remains unmeasured.

The first runtime is native Hugging Face Text Embeddings Inference (TEI). A runtime adapter is separate from a model: a TEI endpoint serves one model, while the collection pins its declared identity and the endpoint-reported metadata. The suggested multilingual models are `BAAI/bge-reranker-v2-m3` and `Alibaba-NLP/gte-multilingual-reranker-base`; bounded custom deployment identifiers are supported when TEI reports the same model. Runtime and model licenses must be assessed independently by operators. No model name or endpoint-reported revision attests to downloaded weights.

## Compatible contract extension

Revision 22 keeps all closed Cohere/Voyage DTOs and the original six-provider credential operations unchanged. New `rag.reranking.extended` operations expose open engine identifiers and score-kind metadata; new `rag.reranking.endpoints` operations manage self-hosted credentials. An older reranking operation fails explicitly before provider I/O when the selected profile is unsupported. Ordinary search remains independent. New engines must implement a native adapter; this is not arbitrary Cohere emulation.

## Schema and saved bindings

The internal credential-provider enum includes `TEI`, without widening legacy public credential enums. `RerankEndpointCredential` stores organization-owned endpoint metadata and an optional encrypted API key, separate from the legacy credential list. At most one row per organization/provider is active, enforced by a partial unique index. Credential operations retain the existing session-only `ragCredentials` permissions, serializable organization fencing, bounded lists, explicit secret preservation/removal and atomic audit.

`CollectionRerankConfig` gains nullable `selfHostedCredentialId` and `runtimeSnapshot`. Existing hosted rows remain byte-for-byte compatible. The composite organization/id/provider foreign key is deferred, as with other retained bindings, so native organization deletion and collection cleanup remain transactional. TEI cannot reference legacy credentials; hosted profiles cannot reference a self-hosted row or runtime snapshot. Referenced destinations cannot be retargeted, but secrets can rotate. Platform fallback occurs only when the organization has no endpoint configuration for the engine.

For an enabled TEI profile, an explicitly requested save fetches bounded `GET /info` after current session, collection-administration and destination checks, outside any database transaction. It performs no inference. A subsequent fenced transaction rechecks authority, CAS revision and credential binding before storing the immutable snapshot. Disabled profiles need no network request. The snapshot contains the protocol, model ID, reported revision, reranker type, runtime version, dtype and reported input/batch limits. TEI's reported `model_sha` is launch metadata, not a computed weight digest.

```mermaid
flowchart LR
    Credentials[Organization endpoint or complete platform default] --> Binding[Exact endpoint and credential binding]
    Binding --> Info[Explicit metadata check outside transaction]
    Info --> Save[Fenced immutable profile revision]
    Save --> OptIn[One-search explicit opt in]
    OptIn --> Check[Live metadata matches saved snapshot]
    Check --> Native[One native rerank POST without truncation]
    Native --> Usage[Validated usage and current authority]
    Usage --> Results[Same candidates and exact sources]
```

The TEI request uses `texts`, `truncate: false`, `raw_scores: false` and `return_text: false`. Every candidate must be represented exactly once. Candidate pools must fit the reported batch size; no split, retry or hidden truncation occurs. Byte limits do not prove token fit; TEI remains responsible for refusing oversized tokenized inputs. A valid optional `x-compute-tokens` value is provider usage; absent token counts and both billing fields remain unknown. The saved endpoint must serve consistent model/metadata across replicas.

The manually generated two-part additive migration expands the existing configuration/request/usage provider checks, adds the new table and constraints, and retains immutable-row guards and trusted SQL function search paths. The proposal, schemas and SQL received independent review before generation. Prisma validation/client generation passed without any database connection. Fresh and upgraded disposable databases passed 111 TEI constraint probes each, together with repeat deployment, schema parity and restore checks. The full catalog run passed 353 main cases and eight accounting cases, including 15 TEI API cases. No application database was used.

## Acceptance recipe

Configure an optional-key TEI endpoint in Integrations, select the self-hosted engine and deployed model in a collection, enable a bounded profile, opt in to one search from Home and the playground, compare the same pool and open the exact source. Verify default/reset/disabled behavior, current permissions, immutable bindings, changed runtime metadata, missing usage and legacy DTO compatibility. Use native curl for document transfers and session-restricted setup; never browser file transfers. A controlled runtime is protocol evidence only. Actual TEI/model execution and hosted-provider relevance remain separate results.

## Actual validation

The isolated run used the official pinned image and GTE model/revision from the [optional CPU deployment guide](rag-tei-deployment.md), reporting TEI `1.9.4`, with four CPUs and an 8 GiB container limit. Cold startup took 81.288 seconds. Its `/info` identity is endpoint-reported metadata, not a verified digest of loaded weights. Indexing used real Ollama 0.40.8 and EmbeddingGemma at 768 dimensions with the verified digest documented in the [Ollama guide](rag-ollama-embeddinggemma.md).

| Check                          | Observed result                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Native setup and persistence   | Curl created the synthetic test setup, uploaded a 2,048-byte FR/EN TXT file and saved the organization TEI endpoint with an explicitly null optional key. Gemma indexing published four children at embedding revision 1.                                                                                    |
| Dashboard metadata save        | In Belgian Dutch, enabling TEI with a pool of eight saved reranking revision 1 through `/info`, without inference or reindexing.                                                                                                                                                                             |
| Real search and comparison     | The Belgian Dutch playground returned four rows for a French question in 536 ms. French Home returned three rows from four candidates for an English question in 513 ms. Same-pool comparison and exact-source preview worked; the one-search controls reset to unchecked.                                   |
| Native exact sources and usage | The supplemental curl search returned three results, reporting 542.198 ms native duration and 754 ms total. TEI reported 409 input tokens; both billing fields remained null. Original access returned the exact 2,048 bytes and SHA-256 `ec7e2086bed47651af1bdd76a1f8d22678db13fbda17e7c5b5ead04083cd74cf`. |
| Locales and layout             | English Integrations and the endpoint-created/reranking-configured audit labels were verified. The French edit form fit 390×844 and Cancel preserved the profile. Dark Belgian Dutch and light French were exercised.                                                                                        |
| Automated checks               | All 26 type tasks, 26 lint tasks, seven unit tasks and four production builds passed. The isolated catalog and schema checks are recorded above; optional keys, revocations and permission boundaries were automated coverage, not browser security mutations.                                               |

The cgroup warmup peak reached the configured 8 GiB limit without an observed OOM; steady recorded usage was 1,812,332,544 bytes. These are container observations, not process RSS measurements or a guarantee that this memory limit is sufficient on another host. The small corpus does not establish quality, throughput, larger-pool latency or capacity. BGE, other custom models and hosted services were not exercised in this real-runtime journey.

An earlier isolated attempt reached a ready runtime but the private helper incorrectly expected patch version `1.9.0`; it refused actual `1.9.4`. That environment was cleaned before the corrected fresh successful run. After browser verification, two localized labels were clarified to distinguish metadata saving from inference and explain the integrations section; those wording-only changes were not rerun in the browser. Their final build status is recorded in the [build log](build-task-log.md).

No browser file transfer, key creation or role/security mutation occurred. Normal dashboard logout completed, the owned tab was closed and its viewport reset. Cleanup verified three terminated application processes, removal of six owned containers and five fresh volumes, an unchanged cached Ollama model, restored helper gates and retained private captures.

## Primary sources

- [TEI native API](https://huggingface.github.io/text-embeddings-inference/)
- [TEI runtime and configuration](https://github.com/huggingface/text-embeddings-inference)
- [BGE model card](https://huggingface.co/BAAI/bge-reranker-v2-m3)
- [GTE model card](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base)
