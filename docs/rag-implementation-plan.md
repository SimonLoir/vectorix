# RAG implementation plan — V1

Prepared on October 21, 2026; delivery sequence revised to require a usable dashboard journey at every product milestone. [Phase 1 infrastructure](rag-infrastructure.md) and the [original phase 2 catalog and access APIs](rag-catalog-access.md) are implemented as technical foundations. The [M1 catalog dashboard](rag-dashboard.md) is implemented and browser-verified. The [M2a.1 TXT/Markdown upload and inspection slice](rag-document-library.md) is implemented. The [M2a.2 replacement/deletion implementation](rag-document-lifecycle.md) is complete and browser-verified. The [M2b PDF/DOCX extraction journey](rag-rich-documents.md) is implemented and browser-verified. The [M3 first Ollama index and search journey](rag-first-search.md) is implemented and browser-verified. The [M4 profile-change/rebuild journey](rag-index-rebuild.md) is implemented and browser-verified. [M5a native Cohere](rag-cohere-embeddings.md) is delivered in PR #28 with controlled dashboard acceptance complete. [M5b native Voyage](rag-voyage-embeddings.md) is implemented with automated validation complete and controlled dashboard acceptance complete. [M5c native OpenAI](rag-openai-embeddings.md) is implemented with automated validation and controlled dashboard acceptance complete. Live paid-provider verification remains pending for all hosted providers. [M5d native Mistral](rag-mistral-embeddings.md) is implemented with automated validation and controlled dashboard acceptance complete. M6a [token-window indexing](rag-token-windows.md) is implemented and browser-verified. M6b [semantic indexing](rag-semantic-planning.md) is implemented with automated validation and real Ollama dashboard acceptance complete. M6c [parent/child context](rag-parent-context.md) is implemented with automated validation and real Ollama dashboard acceptance complete. M7a [freshness and synchronization recovery](rag-sync-freshness.md) is implemented with automated validation and real Ollama dashboard acceptance complete; M7b.1 current-work triage is implemented and browser-verified, M7b.2 recorded activity and worker observations are implemented and browser-verified; M7c.1 full-store restore, fresh-Redis replay, rebuild and natural cleanup are verified; [M7c.2 native reference quality](rag-reference-quality.md) is verified on the frozen FR/EN corpus; remaining M7c capacity and interrupted-process acceptance are required for the agreed V1; delivery evidence is tracked in the [build log](build-task-log.md). The current compatible API revision is `1.18.0`. The proposed initial limits below are configurable and must be validated on the selected infrastructure.

## 1. Agreed scope

- Passage retrieval with source references, available through an API and a web playground.
- Organizations own collections and a shared document library. A document can feed several collections with different configurations.
- Initial formats: text-based PDF, DOCX, TXT, and Markdown. Supported languages: French and English. OCR comes later; explicitly report files without usable text and pages that could not be extracted.
- Originals use S3-compatible storage: organization credentials take precedence, with platform environment configuration as the fallback.
- Restore the `Credentials` mechanism: organization ownership, provider-specific data, encrypted secrets, and masked values in the interface.
- Several native embedding adapters in V1: Ollama, Cohere, Voyage, OpenAI, and Mistral. Embedding credentials follow the same organization-first, environment-second resolution order.
- Three chunking strategies: token windows, document structure, and semantic similarity. Parent/child mode can be combined with these strategies: search child chunks and return parent context.
- Collection-specific permissions assigned to organization members or groups.
- Document managers can access the entire library. Readers can access only documents linked to at least one collection they are authorized to access.
- Hybrid keyword and vector search, with filters, against one collection per request.
- Start with PostgreSQL, pgvector, and pgvectorscale. Each collection has one active vector table in its selected connection. A second temporary table is allowed for reindexing without interrupting search.
- Prepare the architecture for remote connections; customer configuration of remote databases will ship in a later phase.

## 2. Architecture and data ownership

Original files, extracted content, chunks, source positions, and versions remain under platform control. Vectors and the lexical index are derived data that can be rebuilt. Deleting a collection does not delete its documents from the library.

```mermaid
flowchart LR
    U["Organization member"] --> WEB["Web dashboard: configure, upload, inspect, search"]
    OP["Platform operator"] --> ADMIN["Admin dashboard: quotas and service operations"]
    WEB --> API["API: identity, organization, permissions"]
    ADMIN --> API
    CLIENT["API client"] --> API
    API --> APP["Platform PostgreSQL: catalog, versions, chunks, ACLs, lexical index"]
    API --> S3["S3: originals and structured extractions"]
    API --> QUEUE["Redis and BullMQ"]
    QUEUE --> WORKER["Workers: extraction, chunking, indexing"]
    WORKER --> APP
    WORKER --> S3
    WORKER --> EMB["Implemented native adapters: Ollama, Cohere, Voyage, OpenAI and Mistral"]
    WORKER --> VS["Vector storage adapter"]
    API --> VS
    VS --> PG["Selected PostgreSQL: pgvector and pgvectorscale, one active table per collection"]
    VS -. "Future extension" .-> REMOTE["Remote PostgreSQL"]
```

The application database and vector database can initially share a server. Configuring them separately from the outset allows separation testing before remote database management is exposed to users.

The keyword index remains in the application database alongside the chunks. It uses PostgreSQL full-text search and a GIN index. Language configuration must be explicit both when indexing and when querying. [PostgreSQL documentation](https://www.postgresql.org/docs/18/textsearch-tables.html)

The vector table contains chunk identifiers, the index generation, vectors, and metadata required for filtering. It is not the authoritative text store. The platform generates table identifiers and resolves them through its catalog after checking organization ownership; arbitrary client-supplied table names never enter SQL.

Dynamic tables live in a dedicated schema, separate from tables managed by Prisma migrations. The provisioning account has permissions limited to that schema. Installing extensions remains an infrastructure operation.

## 3. Proposed data model

| Area          | Main entities                                                                  | Responsibility                                                                             |
| ------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Integrations  | `Credentials`, S3 and embedding credentials, `StorageLocation`                 | Resolve access configuration and retain storage destinations                               |
| Library       | `Document`, `DocumentVersion`, `DocumentExtraction`                            | Original file, fingerprint, version, structured text, pages, and provenance                |
| Collections   | `Collection`, `CollectionDocument`, `CollectionConfigRevision`                 | Document associations, settings, and configuration revisions                               |
| Indexing      | `IndexGeneration`, `IndexedDocument`, `Chunk`, `IndexTask`, durable events     | Canonical children and parent context, progress, retries, and index publication            |
| Semantic work | `SemanticChunkPlan`, `EmbeddingWorkAttempt`, `OrganizationEmbeddingAccounting` | Versioned boundaries/checkpoints, dispatched work, selected usage and outstanding capacity |
| Connections   | `VectorConnection`                                                             | Vector destination, capabilities, and extension versions                                   |
| Authorization | `OrganizationGroup`, `GroupMember`, `CollectionGrant`, API key scopes          | Member/group access and API client restrictions                                            |
| Operations    | Usage counters and audit log                                                   | Bytes, tokens, vectors, requests, errors, and sensitive operations                         |

Prisma continues to manage application data. SQL operations specific to extensions and dynamic tables are encapsulated in the vector adapter, using Prisma SQL primitives. Migrator migrations cover the stable catalog; provisioning collection tables is a retryable application operation.

Each file retains its storage destination and object key. Changing S3 configuration affects new writes; moving existing files requires an explicit operation. Credentials still referenced by files or collections cannot be deleted without replacement or migration.

A new document version keeps the previous published version available while processing. Each document–collection association records the version currently searchable. Updates propagate to the affected collections after successful extraction.

## 4. Credentials and embedding profiles

Resolve configuration for the requested provider: use organization credentials when present, otherwise use platform environment configuration. Missing configuration can fall back; a configured but invalid key produces an explicit error. Do not combine an organization's key with an endpoint from a different configuration.

Explicitly select an active configuration for each purpose and provider to avoid arbitrarily choosing between several credentials. Retain the references and revisions used by each collection.

A collection's versioned profile fixes the provider, model, dimensions, numeric type, distance metric, and any text preparation instructions. Key rotation does not change that profile. Changes to the model, dimensions, text preparation, or an endpoint that may serve a different model require a new index generation.

The implemented Ollama/Cohere/Voyage/OpenAI/Mistral interface exposes document embedding, query embedding, supported dimensions and context limits, with bounded batches and validated vector outputs. Token counts remain explicitly labeled estimates where no exact tokenizer is available. Adapters translate those operations into each native API. Cohere and Voyage preserve their native query/document roles. [Cohere](https://docs.cohere.com/reference/embed), [Voyage](https://docs.voyageai.com/reference/embeddings-api)

Inputs that exceed the length limit are split again or explicitly rejected, with silent truncation disabled where the API supports it. Validate the returned vector count, dimensions, and values before writing anything. External calls have bounded timeouts and retries. Validate custom endpoints; private destinations needed for Ollama must be explicitly allowed by the operator.

Configure the default provider and model during deployment. Do not embed keys or assume model availability in code. Suggest the model's native dimensions by default, subject to compatibility with the selected index.

M5a supports the reviewed Cohere v4/v3 text-model catalog with the Generic preset through native discovery, probes, document/query embedding, indexing/rebuilding and search. The provider base is the root `https://api.cohere.com`, without a version path. Local Ollama snapshots retain their verified manifest digest; hosted Cohere snapshots record a versioned capability fingerprint that cannot attest to hosted weights. API revision `1.9.0` adds compatible identity/discovery metadata and a saved-revision discovery check. See [native Cohere setup and validation boundaries](rag-cohere-embeddings.md). Controlled provider checks and the completed controlled dashboard acceptance are distinct from the pending live paid-service journey.

M5b implements the reviewed `voyage-4`, `voyage-4-lite` and `voyage-4-large` profiles through native `/v1/embeddings`, with explicit roles, no truncation and indexed response validation. Voyage has no documented native model-list endpoint: listing reads a local reviewed catalog, makes no provider call and does not validate credentials. Optional `reviewedCatalog` metadata in compatible API revision `1.10.0` preserves existing discovery enums. Actual saved-model verification probes both roles. The new schema-version-3 capability fingerprint preserves older Ollama/Cohere snapshots and does not attest to hosted weights. Automated validation is complete; controlled dashboard acceptance is complete and live paid-service verification remains pending. See [Voyage configuration and validation status](rag-voyage-embeddings.md).

M5c implements native OpenAI `models`/`embeddings` relative to the complete saved API base, including `/v1` or an approved proxy prefix. Reviewed `text-embedding-3-small`/`large` shortening ranges are 1–1536/3072; the exact saved size is probed. OpenAI uses the same native input semantics for document and query operations, with no invented role/truncation fields. Schema-version-4 capability fingerprints preserve versions 1–3. Compatible API revision `1.11.0` adds optional authoritative dimension-range metadata while retaining the legacy exact-probed-size hint. Automated validation and controlled dashboard acceptance are complete; live paid-service verification remains pending. See [OpenAI configuration and validation status](rag-openai-embeddings.md).

M5d implements native Mistral catalog/probes and fixed 1024-dimensional text embeddings through complete saved API bases. The reviewed `mistral-embed`/`mistral-embed-2312` pair uses Generic shared-input semantics. Schema-version-5 snapshots bind the selected and actually observed response IDs; both probes and later calls require stable observed identity. The 8000 processing context and 64-input/16000 reserved-byte batch policy are conservative Vectorix limits, not invented native guarantees. Compatible API revision `1.12.0` adds optional `responseModel` verification metadata and preserves OpenAI ranges and older snapshots. Automated validation and controlled dashboard acceptance are complete; live paid-service verification remains pending. See [Mistral configuration and validation status](rag-mistral-embeddings.md).

## 5. Ingestion, chunking, and publication

```mermaid
flowchart TD
    UP["Authorized upload and quota reservation"] --> OBJ["Original retained in S3"]
    OBJ --> VER["Document version and durable task"]
    VER --> EX["Extract text, pages, headings, and positions"]
    EX --> SRC["Extraction retained on the platform"]
    SRC --> LINK["Collections linked to the document"]
    LINK --> SPLIT["Chunk using each collection's configuration revision"]
    SPLIT --> CHUNK["Child chunks and optional parents"]
    CHUNK --> LEX["Child lexical index staged on the platform"]
    CHUNK --> PC{"Parent context enabled?"}
    PC -->|Yes| SEAL["Seal complete canonical child and parent layout"]
    PC -->|No| EMB["Embed searchable children"]
    SEAL --> EMB
    EMB --> VEC["Write and validate vectors"]
    LEX --> READY["Verify text, vector, and metadata consistency"]
    VEC --> READY
    READY --> PUB["Publish the searchable version"]
```

Uploads validate the organization, permissions, actual file type, size, and quota. Parsers have memory, runtime, and decompressed-size limits. Sanitize HTML previews. Extracted text retains page references for PDFs and section/position references for other formats; do not invent page numbers for DOCX or text files.

BullMQ tasks contain identifiers, without secrets or files. Their durable state remains in PostgreSQL. A transactional outbox event allows a task to be retried even if enqueueing in Redis fails after the database write. Steps are idempotent; retries do not publish duplicate chunks. Deduplication and caches are scoped to the organization and include extraction and configuration versions.

M6b [semantic chunking](rag-semantic-planning.md) uses deterministic sentence/block units and the collection's saved native embedding profile. Adjacent float32 cosine distances use a nearest-rank percentile; positive ties can all qualify. Accepted prefixes and one last vector are checkpointed, and final ranges are sealed before chunk materialization. Planning processes at most 32 units per claim. The dashboard exposes progress, separate semantic work/usage and admin quota controls; automated validation and real Ollama browser acceptance are complete.

Logical boundary and final-document batches share a bounded lifetime candidate allowance. Dispatch intent, confirmed responses, unknown native usage and unresolved work remain distinct; retries cannot erase historical work. Successful continuations do not spend failure retries. A bounded scan prioritizes actual reservation holders while preserving ordinary task slots, and policy increases do not force active holders to enlarge reservations. See the semantic guide for exact limits, cleanup and current validation evidence.

M6c [parent context](rag-parent-context.md) is implemented for the three child strategies and five native providers. The separately saved `parent-context-utf8-v1` descriptor preserves child algorithm and semantic-plan identities. Canonical parent-enabled rows are create-only; a complete application seal precedes external child-vector publication. Only children are embedded, ranked and counted against passage quotas. Parents add bounded derived application text/provenance storage and use the same exact-version sources. Automated validation is complete; real Ollama dashboard acceptance is complete.

Recheck changes and deletions that occur during a task before publication. An outdated task must never restore a deleted document or an obsolete configuration.

## 6. Hybrid search and authorization

```mermaid
sequenceDiagram
    participant C as Client
    participant A as API
    participant P as Platform PostgreSQL
    participant E as Embedding provider
    participant V as Vector database
    C->>A: Collection, query, filters, result count
    A->>P: Check organization, access, and active generation
    P-->>A: Authorization and search configuration
    par Keyword branch
        A->>P: Filtered lexical search in the active generation
        P-->>A: Identifiers and lexical ranks
    and Vector branch
        A->>E: Embed query using the collection profile
        E-->>A: Vector
        A->>V: Filtered vector search in the active table
        V-->>A: Identifiers and distances
    end
    A->>A: Merge child ranks
    A->>P: Read eligible child and parent identities only
    P-->>A: Bounded identity metadata
    A->>A: Deduplicate parents before final topK
    A->>P: Hydrate selected child and parent pairs, at most 64 spans per row
    P-->>A: Bounded content and version references
    A->>P: Recheck current access and exact publications
    P-->>A: Current eligibility
    A-->>C: Results, scores, and sources
```

Read the active generation once per request so both branches use the same index generation. Apply supported filters to both searches before selecting candidates. Final hydration rechecks content existence, published versions, and access; logical deletions take effect without waiting for vector cleanup.

Implemented fusion method: Reciprocal Rank Fusion (RRF), which combines ranks from the two result lists. Do not add vector distances directly to lexical scores. This approach is also described in the [pgvector documentation](https://github.com/pgvector/pgvector#hybrid-search).

V1 filters include document identifiers, language, file type, tags, and dates, plus a set of typed metadata fields declared on the collection. Validate fields and operators on the server; do not accept arbitrary SQL expressions. Metadata changes are versioned and reconciled across both indexes.

In parent/child mode, each branch retrieves one bounded child candidate window of at most 500 entries. Group metadata-only child candidates by exact candidate/parent before final `topK`; keep the strongest representative child and its original scores, without summing siblings or repeating query embeddings. Hydrate only selected child/parent pairs with at most 64 projected source spans per row inside PostgreSQL. Compatible API `1.15.0` adds optional context, canonical ranges and saved layout metadata. `parentUnderfilled` describes distinct-parent underfilling in that bounded window separately from `vectorUnderfilled`; neither establishes corpus exhaustion. Source actions retain the child receipt and current exact-version authorization.

Each result contains the matching chunk, optional parent context, document and version, pages or positions, metadata, ranking scores, and authorized access to the source. A ranking score must not be presented as a probability of truth. If either search branch fails, return an explicit error in V1 instead of presenting partial retrieval as a complete hybrid search.

Organization-level permissions remain a prerequisite; collection grants can allow reading/searching, managing documents within the collection, or administering the collection. Groups are new entities, separate from existing roles. Authorized owners and administrators manage grants; their ability to read content requires an explicit permission.

API keys receive collection scopes intersected with their owner's current permissions and organization permissions. Check access revocation on the server, including management tasks and direct document access. For downloads, the API authorizes every request and serves the private file; S3 objects are not public. Library managers have an explicit permission to read the full library, which does not automatically grant search access to every collection.

## 7. Reindexing without downtime

Implemented by [M4](rag-index-rebuild.md), extended in [M5a](rag-cohere-embeddings.md), [M5b](rag-voyage-embeddings.md), [M5c](rag-openai-embeddings.md) and [M5d](rag-mistral-embeddings.md) to Ollama/Cohere/Voyage/OpenAI/Mistral document-structure profiles without parent/child expansion. Browser acceptance and delivery are recorded separately in the provider/rebuild documents and [build log](build-task-log.md); controlled Voyage dashboard acceptance is complete. M6a adds [token-window profiles](rag-token-windows.md), with automated validation and browser acceptance complete. M6b [semantic profiles](rag-semantic-planning.md) now use the same rebuild/cutover path, with automated checks and real Ollama dashboard acceptance complete. M6c adds optional parent context to the same saved-profile/rebuild path; automated validation is complete and real Ollama dashboard acceptance is complete.

```mermaid
flowchart LR
    LIVE["Generation A active"] --> SERVE["Search remains available on A"]
    CHANGE["New configuration or destination"] --> BUILD["Build generation B: chunks, lexical index, and vector table"]
    BUILD --> SYNC["Catch up on updates and deletions"]
    SYNC --> CHECK["Verify consistency and catch-up state"]
    CHECK --> SWITCH["Switch the active pointer to B"]
    SWITCH --> NEW["New searches use B"]
    SWITCH --> OLD["Retain A for requests and source grace, then clean physically"]
    BUILD -. "Failure" .-> LIVE
```

A generation includes its configuration revision and the document versions actually indexed. Rebuilding produces a new vector table and new chunks/lexical indexes without changing the generation being queried. Document changes are recorded in an ordered log and replayed before switching, with a short lock to finalize the catch-up point.

Publication uses an application database transaction only after both indexes confirm their writes. It does not assume a distributed transaction between the platform and vector database. Requests that started on the previous generation may finish; cleanup waits until they have expired. A failed rebuild leaves the previous generation active. The dashboard distinguishes the latest saved draft from the serving configuration, compares both before confirmation and exposes generation-specific previews, progress, retry and discard. Search filters follow the active declaration; document metadata edits use the latest saved declaration. Shared metadata keys cannot change type while a non-cleaned generation retains their old type. A building or failed candidate locks profile changes, while name/description edits remain available.

Acceptance requires a current session, organization update/document-management permissions and both explicit administration/document-management collection grants. The initiating or retrying authority is rechecked before provider work and activation. At most two non-cleaned tables per collection and one rebuild candidate per organization are admitted. Retired/discarded tables keep their charges until physical cleanup is confirmed; a failed or discarded candidate must be cleaned before another build starts.

Deleting a collection immediately revokes access and schedules cleanup of its indexes and chunks. Shared documents remain available according to their other associations. Deleting a library document invalidates its associations and schedules removal of the affected objects and indexes, with durable retries if storage is unavailable.

## 8. Proposed initial settings

These values are initial service limits, adjustable through configuration and, for quotas, per organization. They are not guaranteed infrastructure capacities.

| Setting                      | Initial value                                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Languages                    | FR and EN, with detection and manual correction                                                                                                    |
| Collections per organization | 20                                                                                                                                                 |
| Documents per library        | 5,000                                                                                                                                              |
| Maximum original file size   | 25 MiB                                                                                                                                             |
| Total document storage       | 10 GiB per organization, including originals and extractions                                                                                       |
| Searchable chunks            | 100,000 per active collection; a separate temporary allowance for rebuilding                                                                       |
| Default chunking at creation | Document structure, target of 512 tokens, overlap of 64 tokens                                                                                     |
| Parent/child mode            | Children of 512 tokens, parents up to 2,048 tokens                                                                                                 |
| Semantic chunking            | Target of 512 tokens, bounds of 128–768; initial threshold at the 90th percentile of distances between blocks, to be calibrated against the corpus |
| Semantic planning units      | 8,192 useful units per document, with a separate bounded scanner-work limit                                                                        |
| Semantic plan storage        | 1 MiB per candidate; 64 MiB stored plus reserved per organization                                                                                  |
| Semantic lifetime work       | 128 MiB prepared input and 4,096 logical batches per candidate, including boundary/final work and retries                                          |
| Semantic outstanding work    | 512 MiB and 16,384 logical batches per organization; these are capacity limits, not monetary credits                                               |
| Dimensions                   | Native model dimensions by default, restricted to supported model/type/index combinations                                                          |
| Metric and representation    | Cosine and floating-point values for the first set of validated profiles                                                                           |
| Search                       | 10 results by default, maximum 50; query limit of 4,000 characters, followed by model length validation                                            |
| Hybrid candidates            | Initially 100 per branch; a cap of 500 for additional candidate retrieval                                                                          |
| Fusion                       | RRF with constant 60 and equal weights initially                                                                                                   |
| Ingestion                    | 2 active tasks per organization, 4 across the initial deployment                                                                                   |
| Rebuilds                     | 1 per collection and 1 per organization at a time                                                                                                  |
| Search rate                  | 5 requests/second/organization, burst of 10, 5 concurrent searches per organization                                                                |
| Retries                      | 5 attempts for transient errors, exponential backoff, respecting provider retry instructions                                                       |

Current chunk planners estimate tokens as `ceil(UTF-8 bytes / 3)` and separately enforce the verified prepared-input byte cap after title/preset/preparation overhead. Native embedding usage estimates sum `ceil(prepared UTF-8 bytes / 4)` per input. Neither estimate is an exact tokenizer count or a provider bill; reported native and billed usage remain separate and may be unknown.

The lexical index uses explicit FR/EN configurations and a `simple` path for identifiers and mixed-language documents. Analyze queries with the required configurations and merge lexical candidates before hybrid fusion. Validate this behavior with bilingual queries and documents.

## 9. Dashboard-testable delivery milestones

The milestones below replace the former backend-first work packages. References to phases 1 and 2 in the infrastructure and catalog documentation describe the existing foundations, not completion of these new product milestones. There is no separate late-stage interface milestone: every feature ships with its dashboard entry point, API, persistence, necessary worker processing, permission checks, and visible result.

### Completion rule for every milestone

- A member or platform administrator can exercise the delivered capability from the appropriate dashboard after normal deployment setup, without SQL edits, curl, or API documentation as the primary user interface.
- Forms, lists, details, and actions use the real API and persisted data. Reloading, switching organizations, and opening direct URLs preserve the correct state and permissions.
- Include empty, loading, success, forbidden, validation-error, and operational-failure states. Background work exposes durable progress and safe retry actions when applicable. Do not display a placeholder as a completed operation.
- Implement authorization, audit, quotas, idempotency, and cleanup alongside the operation that needs them. The final operations milestone does not defer these protections.
- Document a reproducible browser acceptance scenario, its prerequisites, expected results, and the checks actually run in the PR and [build log](build-task-log.md). Browser verification complements automated API and isolation tests; it does not replace them.
- Keep each implementation PR focused on a complete user action. If a milestone needs several PRs, split by usable actions or supported formats/providers, each with its interface, rather than delivering all backend work before the screens. Technical prerequisites are explicitly labeled as foundations and do not close a product milestone.

### Delivery order

M1 is implemented and verified. M2a.1 upload and inspection is implemented. M2a.2 replacement/deletion is implemented and browser-verified; M2b PDF/DOCX extraction is implemented and browser-verified; M3 is implemented and browser-verified; M4 is implemented and browser-verified; M5a native Cohere is delivered with controlled dashboard acceptance complete; M5b Voyage is implemented with automated validation complete and controlled dashboard acceptance complete. M5c OpenAI is implemented with automated validation and controlled dashboard acceptance complete. Live paid-provider verification remains pending for all hosted providers. M5d Mistral is implemented with automated validation and controlled dashboard acceptance complete. M6a [token-window indexing](rag-token-windows.md) is implemented and browser-verified. M6b [semantic indexing](rag-semantic-planning.md) is implemented with automated validation and real Ollama dashboard acceptance complete. M6c parent/child context is implemented with automated validation and real Ollama dashboard acceptance complete. M7a freshness/recovery is implemented and browser-verified. M7b.1 current-work triage is implemented and browser-verified; M7b.2 historical observations are implemented and browser-verified; M7c.1 full-store restore/replay/rebuild/natural cleanup and M7c.2 native reference quality are verified; capacity and interrupted-process acceptance remain pending. M1 completes the user-facing portion of the existing catalog backend. The staged delivery of formats, providers, and chunking options does not remove any agreed V1 capability.

| Milestone                                                               | Complete scope                                                                                                                                                                                                                                                                                                | Dashboard acceptance scenario                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 — Catalog dashboard (implemented)**                                | Organization integrations, collection profiles, groups and grants, API-key collection scopes, quota/usage and audit views; platform quota editing in the admin dashboard. Reuse the existing catalog APIs.                                                                                                    | Configure masked credentials, create and reopen a collection, edit its profile, grant and revoke group access, configure a scoped key, and change an organization quota as a platform administrator. Verify persistence and a second member's denied access.                        |
| **M2a.1 — Upload and inspect TXT/Markdown (implemented)**               | Private S3 upload, original and extraction reservations, durable tasks, previews, authenticated downloads, safe retry, and collection associations. Documents remain independent of vectors.                                                                                                                  | Upload FR/EN files, reload and follow processing, inspect plain text, download identical originals, and attach one document to two collections. Verify reader denial/revocation, quota failures, invalid UTF-8 and restart recovery.                                                |
| **M2a.2 — Replace and delete documents (implemented)**                  | Version replacement, document deletion, durable object cleanup, reservation release, retention controls and related dashboard confirmations/status.                                                                                                                                                           | Replace an original, inspect the current version, delete it and verify immediate reader denial. Recover cleanup after an S3 outage and confirm storage quota release.                                                                                                               |
| **M2b — PDF/DOCX library (implemented)**                                | Add text-based PDF and DOCX through the same upload, extraction, version, and preview journey; retain page or section/position provenance and parser resource limits.                                                                                                                                         | Upload each format and follow its source references in the preview. A scanned PDF reports that OCR is unavailable; unusable text is never reported as successful extraction. Each format can be a separate complete PR.                                                             |
| **M3 — First searchable collection (implemented)**                      | Ollama native adapter, model/dimension validation, document-structure chunking, chunk preview, durable indexing, dynamic PostgreSQL vector tables, lexical indexing, filtered hybrid API, and the dashboard playground. Include publication, update, deletion, retries, and quota enforcement.                | Choose an available Ollama model, attach library documents, start indexing, inspect progress/chunks, then ask FR/EN questions with filters and open authorized sources. Replacing or deleting a document updates searchable content without exposing unpublished or stale versions. |
| **M4 — Change a profile and rebuild (implemented; browser-verified)**   | Draft/serving profile comparison and confirmation, a new generation/table, source/association/metadata catch-up, atomic activation, bounded old-source retention and physical cleanup, generation previews, and visible progress/failure/retry/discard.                                                       | Change model or dimensions in the collection settings, launch a rebuild, and keep searching the previous generation in the playground. Observe the successful switch; a failed rebuild leaves the old generation usable.                                                            |
| **M5a — Native Cohere (implemented; controlled acceptance complete)**   | Native discovery/probes, reviewed model/dimension controls, query/document roles, credential resolution, capability-profile identity, indexing/rebuilding and search through the existing dashboard.                                                                                                          | Save and verify a Cohere profile, rebuild from Ollama while searching, retrieve filtered passages and exact sources, and exercise explicit failures. Controlled HTTP/dashboard checks are separate from pending live paid-provider verification.                                    |
| **M5b — Native Voyage (implemented; controlled acceptance complete)**   | Native document/query embeddings, a reviewed local catalog with explicit unverified labels, coherent profile controls, saved bindings, immutable capability profiles, indexing/rebuilding and search.                                                                                                         | Configure the saved provider, inspect the local catalog, verify both roles, index/rebuild and inspect exact sources. Listing is not credential verification; invalid organization credentials must fail actual probes without fallback.                                             |
| **M5c — OpenAI (implemented; controlled acceptance complete)**          | Native discovery, exact-size probes, numeric shortening ranges, immutable capability profiles, complete saved API bases, indexing/rebuilding and search.                                                                                                                                                      | Save an arbitrary supported size such as 257, verify, index/rebuild and retrieve exact sources; invalid organization credentials fail without fallback.                                                                                                                             |
| **M5d — Mistral (implemented; controlled acceptance complete)**         | Native catalog/probes, fixed 1024-dimensional text models, explicit reviewed aliases, immutable observed response identity, complete credential bindings, localized profile controls, indexing/rebuilding and search.                                                                                         | Verify selected and observed Mistral IDs, index/rebuild while searching, and inspect exact sources. Response-identity drift and invalid organization credentials fail explicitly without fallback.                                                                                  |
| **M6a — Token windows (implemented; browser-verified)**                 | Deterministic estimated-token windows, versioned planning, validated settings, chunk preview, usage accounting, indexing/rebuilding and result inspection. Document-structure chunking retains its saved version.                                                                                             | Create a token-window collection or rebuild a structure collection, inspect bounded chunks, search FR/EN text, retry failures, and open exact authorized sources. Compare the saved active/draft strategies.                                                                        |
| **M6b — Semantic chunking (implemented and browser-verified)**          | Versioned canonical units, float32 distances/percentile ties, durable prefix checkpoints/sealed plans, bounded native work/usage, compatible quota APIs, localized web/admin controls and retry/cleanup safeguards. Automated validation is complete.                                                         | Index a multi-topic document with real Ollama, inspect chunks/progress, search FR/EN and compare a threshold rebuild. Inspect known/unknown usage and change semantic policy in admin. Actual validation and its limits are recorded in the semantic guide/build log.               |
| **M6c — Parent context (implemented; browser-verified)**                | Versioned parent layout across three child strategies/five native providers; create-only canonical rows, application seal, child-only vectors/accounting, bounded metadata-first deduplication, compatible context DTOs and localized controls. Automated checks are complete.                                | Enable parents, inspect child/context preview, search FR/EN with unique parents, retain exact sources across a parent-size rebuild, and verify current permissions. Real Ollama dashboard acceptance is complete; actual evidence is recorded in the parent guide/build log.        |
| **M7a — Collection freshness and recovery (implemented)**               | Configured automatic synchronization, current authorization, explicit adoption with task fencing, exact desired/searchable versions and task-scoped recovery. Automated validation and real Ollama dashboard acceptance are complete.                                                                         | Replace a shared source as a library-only writer, observe both collections catch up, recover revoked control through adoption/retry, then verify the next replacement and exact sources from the dashboard.                                                                         |
| **M7b.1 — Current work triage (implemented)**                           | Bounded organization current-work counts and grant-filtered details from existing durable tasks, acceptance age/scheduling/claim semantics, links to existing guarded recovery and admin technical totals. No schema change is introduced.                                                                    | Find a real failure across collections/library, open its authorized existing screen, recover it and observe the snapshot converge; inspect future cleanup separately from due checks.                                                                                               |
| **M7b.2 — Historical operations and worker observations (implemented)** | Bounded all-strategy ingestion/search observations, phase latency and durable worker evidence with explicit tracking windows, gaps and unknown values; the additive [schema and observation design](rag-observability.md) is implemented with automated checks and real Ollama dashboard acceptance complete. | Observe real activity, controlled failure and worker interruption through the dashboards without inferring liveness or billing from task counts.                                                                                                                                    |
| **M7c — Recovery, quality and capacity acceptance (in progress)**       | Full-store restore/replay/rebuild/natural cleanup and frozen FR/EN reference quality are verified. Load/fairness and interrupted-process acceptance remain pending; all six image checks pass for the restore slice.                                                                                          | After an isolated restore, verify documents, exact sources, access and search; record actual corpus/load results without treating small fixtures as a capacity benchmark.                                                                                                           |

```mermaid
flowchart TD
    BASE["Existing infrastructure and catalog APIs"] --> M1["M1: configure catalog and access in the dashboard"]
    M1 --> M2A["M2a.1: upload and inspect TXT / Markdown"]
    M2A --> M2A2["M2a.2: replace, delete and clean up documents"]
    M2A2 --> M2B["M2b: upload and inspect PDF / DOCX"]
    M2B --> M3["M3: index and search with Ollama"]
    M3 --> M4["M4: change profile and rebuild while searching"]
    M4 --> M5A["M5a: native Cohere implemented; controlled acceptance complete"]
    M5A --> M5B["M5b: native Voyage implemented; controlled acceptance complete"]
    M5B --> M5C["M5c: OpenAI implemented; controlled acceptance complete"]
    M5C --> M5D["M5d: Mistral implemented; controlled acceptance complete"]
    M5D --> M6A["M6a: token windows implemented and browser-verified"]
    M6A --> M6B["M6b: semantic chunking implemented and browser-verified"]
    M6B --> M6C["M6c implemented: parent context and browser verification complete"]
    M6C --> M7A["M7a implemented: freshness and authorized recovery"]
    M7A --> M7B1["M7b.1 implemented: current work triage"]
    M7B1 --> M7B2["M7b.2: recorded activity and worker observations"]
    M7B2 --> M7C["M7c: restore and reference quality verified; capacity pending"]
```

M1 records configuration, not provider connectivity or search readiness: saved credentials must not be labeled as live-verified, and a collection without an index must not be labeled searchable. With M4, profile edits save a new draft while the active generation retains its immutable configuration. Building/failed candidates lock further profile changes until activation or discard; activation requires the reviewed revision and predecessor pointer. Catalog profiles already stored for capabilities not yet implemented remain inspectable, but indexing must explicitly reject them and the UI must explain availability. Only offer an executable action once its complete path exists.

### M1: implemented catalog dashboard

The following implemented screens close the catalog gap. Keep this acceptance checklist for regressions; see [implementation entry points and actual browser results](rag-dashboard.md).

- **Integrations:** list, create, edit, select, rotate, and delete S3/Ollama/Cohere/Voyage/OpenAI/Mistral credentials where permitted. Mask secrets, explain organization/environment resolution, show retained-reference restrictions, and distinguish saved configuration from live verification.
- **Collections:** list, create, inspect, revise, and delete catalog entries; display the selected provider/model/dimensions, chunking profile, platform vector destination, and immutable revision history. Link to the document library and indexing workspace. Distinguish saved profiles from the active generation; expose only the providers and strategies whose execution paths are implemented.
- **Groups and access:** manage organization groups and their members, then edit explicit member/group collection grants. Catalog administration must not imply content-reading access.
- **API keys:** extend the existing key screens with collection scopes intersected with the issuer's current rights. Explain why historical unbound keys need replacement. The dashboard manages scopes; automated API tests verify actual key use and revocation.
- **Usage and audit:** display enforced collection limits, stored quota policies, recorded usage, and safe audit entries. Keep enforced original/storage/passage quotas and authoritative semantic work accounting separate from the implemented best-effort M7b.2 operational observations. Platform administrators can edit organization quota overrides in the admin interface.

Browser recipe: use two organizations and two members with distinct permissions. In the first organization, configure credentials, create a collection, save a revised profile, create a group, and assign/revoke a grant. Reload between actions and verify saved state, masked values, and the resulting audit entries. Configure a key's scopes without granting permissions the issuer lacks. Change the collection quota in admin and trigger its limit through web creation. Switch to the second member and organization to verify filtered navigation, list contents, forbidden actions, and direct URL handling. Document the actual result of each step; the existing API suite alone does not complete this checklist.

### Integration entry points and data flow

Existing entry points to reuse:

- `apps/web/components/app-sidebar.tsx` and `apps/web/app/dashboard/` provide navigation and page shells. Implemented catalog routes are `dashboard/collections`, `dashboard/settings/integrations`, `dashboard/settings/groups`, `dashboard/settings/usage`, and `dashboard/settings/audit`. Focused views live in `apps/web/components/rag/`. The `dashboard/documents` and `dashboard/documents/[id]` routes provide upload and inspection. M2a.2 adds manager replacement/deletion dialogs, version history, a deleted-documents view and cleanup retry; it is browser-verified. See [document lifecycle entry points](rag-document-lifecycle.md#implementation-entry-points).
- `apps/web/app/dashboard/account/api-keys/page.tsx` and its `components/api-key-permissions-dialog.tsx` own key configuration; reuse the existing member/role settings when selecting principals and checking organization permissions.
- `apps/web/contexts/orpc.tsx` supplies the authenticated versioned client. Forms call contracts in `packages/api-contracts/src/v1/rag/` and the existing key contracts in `packages/api-contracts/src/v1/organizations/access.ts`; handlers in `packages/routers/rag/` enforce access, persist catalog changes, and write audit records transactionally before the UI refreshes affected queries.
- `apps/admin/src/app/(dashboard)/organizations/[id]/page.tsx` and `apps/admin/src/components/organization-workspace.tsx` are the organization administration entry points. Legacy quota changes use `packages/routers/superadmin/src/set-rag-quota.ts`. Separate semantic policy/usage controls use `organization-semantic-{quota,usage}.tsx` and `get-semantic-quota.ts` / `set-semantic-quota.ts`, preserving the strict six-field legacy quota contract.
- `packages/ui` and `packages/dashboard-core` supply shared accessible components. Ingestion and indexing actions persist tasks/change receipts in `packages/db`, enqueue identifiers through `packages/queues`, and run processing in `apps/workers`; dashboard status reads authoritative persisted state through the API. Rebuild controls and generation-aware previews live in `apps/web/components/rag/indexing/`; see the [M4 integration entry points](rag-index-rebuild.md#integration-entry-points).

Native provider protocols and versioned identity parsing live in `packages/embeddings/`; saved binding/endpoint checks and discovery/probes live in `packages/routers/rag/src/services/indexing/`. Controlled collection fields, saved model discovery and accurate fingerprint labels live in `apps/web/components/rag/{collections,indexing}/`. See [M5a integration and validation](rag-cohere-embeddings.md), [M5b configuration and acceptance](rag-voyage-embeddings.md), [M5c configuration and acceptance](rag-openai-embeddings.md) and [M5d configuration and acceptance](rag-mistral-embeddings.md).

M6b adds pure semantic geometry under `packages/chunking/src/semantic-*.ts`, native lifecycle observers in `packages/embeddings/src/batch-observer.ts` and focused orchestration/accounting under `packages/routers/rag/src/services/indexing/semantic-*.ts`. The reviewed additive migration is `20261028000000_rag_semantic`; compatible API revision `1.14.0` adds optional outer semantic progress/usage and separate admin policy operations. The organization usage page and collection tasks show metadata without exposing checkpoint vectors. See [semantic persistence, protocol and acceptance](rag-semantic-planning.md).

M6c adds `packages/chunking/src/parent-context*.ts`, immutable application layout/sealing in `chunk-materialization.ts`, bounded PostgreSQL JSON projection in `chunk-projection.ts`, metadata-only grouping in `search-representatives.ts`, and current preview-capability checks in indexing `access.ts`. Its approved additive migration is `20261029000000_rag_parent_context`; optional compatible API `1.15.0` fields preserve historical child-only DTOs. Web context panels share the child source receipt; no parent-ID read route exists. See [parent context, rollout and current acceptance](rag-parent-context.md).

Keep shared storage, extraction/chunking, embedding, vector, and retrieval logic in focused modules reused by API and workers. Heavy parsers remain in the workers. Remote database configuration and OCR remain outside V1; when scheduled, each must include its own complete dashboard journey.

## 10. Validation throughout delivery and final V1 acceptance

Run the applicable browser journey and backend checks at **each milestone**, adding coverage as its capabilities ship. The final V1 scenario is a regression across those delivered journeys, not the first opportunity to test them from the dashboard: use two organizations and FR/EN documents, upload, attach a document to two differently configured collections, index, run hybrid search with sources and parent context, grant group access, revoke access, replace a document, and reindex without downtime.

Required validation:

- Integration tests with PostgreSQL and real extensions, Redis, and S3-compatible storage; PDF/DOCX/TXT/Markdown fixtures with expected source positions.
- Negative authorization tests for every access path: search, listing, original file, extracted content, parent context, version history, API keys, and job management.
- Worker termination at each stage; Redis/S3/vector database outages; provider 429 responses, invalid vectors, and partial responses. Verify retries and the absence of inconsistent publication.
- Reindexing during uploads, replacements, filter changes, and deletions. Verify that text and vectors belong to the reported generation.
- Mock providers for deterministic CI, plus live dashboard/contract checks with an available local Ollama model and dedicated Cohere/Voyage/OpenAI/Mistral credentials when available. Record simulated and live results separately. If credentials are unavailable, report live verification as pending; never claim that mocked responses prove a working live provider journey.
- An initial evaluation set of 40 annotated queries, half French and half English, covering exact keywords, paraphrases, filters, and parent context. The [frozen native reference baseline](rag-reference-quality.md) compares lexical, vector and hybrid retrieval across three chunkers and two repetitions. Its gates pass; development queries remain separate for later tuning, and changes to scored inputs require a new recorded baseline.
- Initial load benchmark: 100,000 chunks in one collection, 10 concurrent searches distributed across organizations, and concurrent ingestion. Target to measure: internal search p95 below 1 second, excluding query embedding; also report total latency with each provider. These are validation targets, not achieved results.
- Back up and restore the catalog and objects, then rebuild indexes; verify deletions and cleanup of obsolete generations. The first [isolated full-store restore acceptance slice](rag-restore-acceptance.md) is verified through restored dashboard access/search, fresh-Redis replay, rebuild and natural cleanup; [reference quality](rag-reference-quality.md) is verified separately, while capacity remains unmeasured.

Hardware sizing, enabled models, and costs depend on hosting and available credentials. Confirm a usable local Ollama model before M3 and arrange provider credentials before the corresponding M5 live acceptance checks. These deployment prerequisites do not change the agreed functional scope.
