# Vectorix

A multi-organization application foundation written in TypeScript. It includes a Next.js dashboard, a Hono/oRPC API, an administration panel, BullMQ workers, and a Prisma/PostgreSQL migrator.

## Local development

Requirements: Node.js 24, pnpm 11.25, and Docker Compose 2.24.4 or later for PostgreSQL, Redis, the vector database, and RustFS. The vector database requires AVX2 and FMA on x86 hosts (including VMs), or NEON on ARM.

```sh
pnpm install --frozen-lockfile
pnpm setup:env
# Adjust .env if the default ports are already in use.
docker compose up --build -d
pnpm db:generate
pnpm db:migrate
pnpm dev
```

`setup:env` generates random secrets and never overwrites an existing file. The `.env` file remains local and is not committed. Development services use these ports:

| Service                           | Address               |
| --------------------------------- | --------------------- |
| Dashboard                         | http://localhost:3000 |
| API and interactive documentation | http://localhost:3001 |
| Administration                    | http://localhost:3006 |
| PostgreSQL                        | localhost:5432        |
| Redis                             | localhost:6379        |
| Vector PostgreSQL                 | localhost:5433        |
| RustFS S3 API                     | http://localhost:9000 |
| RustFS console                    | http://localhost:9001 |

The vector database uses PostgreSQL 18.6 with pgvector 0.8.7 and pgvectorscale 0.9.1. RustFS 1.0.3 provides a private document bucket initialized by the one-off `s3-init` service. Each database and object store has its own named volume. Existing `.env` files need the new vector/S3 settings from `.env.example`; `setup:env` preserves existing files. See [RAG infrastructure](docs/rag-infrastructure.md) for connection roles, setup, and upgrade behavior. The [catalog and access APIs](docs/rag-catalog-access.md) and [catalog dashboard](docs/rag-dashboard.md) are implemented. Configure integrations, collection profiles, groups, grants, and scoped keys from the dashboard; inspect usage and audit there, and edit organization quotas in the admin panel. The [TXT/Markdown library](docs/rag-document-library.md) provides private upload, background extraction, preview, authenticated original download and collection associations. The [document lifecycle](docs/rag-document-lifecycle.md) adds replacement, deletion, retention delays and durable cleanup; M2a.2 is implemented and browser-verified. The [PDF/DOCX extraction slice](docs/rag-rich-documents.md) and [first Ollama index/search journey](docs/rag-first-search.md) are implemented and browser-verified. [Profile changes and rebuilds](docs/rag-index-rebuild.md) are implemented and browser-verified. [Native Cohere embeddings](docs/rag-cohere-embeddings.md) are implemented with controlled dashboard acceptance complete. [Native Voyage embeddings](docs/rag-voyage-embeddings.md) are implemented with automated validation complete and controlled dashboard acceptance complete. [Native OpenAI embeddings](docs/rag-openai-embeddings.md) are implemented; automated validation and controlled dashboard acceptance are complete. Live paid-provider verification remains pending for all hosted providers. [Native Mistral embeddings](docs/rag-mistral-embeddings.md) are implemented with automated validation and controlled dashboard acceptance complete. [Token-window indexing and rebuilds](docs/rag-token-windows.md) are implemented and browser-verified as M6a. [Semantic indexing](docs/rag-semantic-planning.md) is implemented and browser-verified. [Parent/child context](docs/rag-parent-context.md) is implemented with automated validation and real Ollama production-dashboard acceptance complete. M7a [freshness and recovery](docs/rag-sync-freshness.md) and M7b.1 [current-work triage](docs/rag-operations.md) are implemented and browser-verified. M7b.2 [recorded activity](docs/rag-observability.md) is implemented and browser-verified; [M7c.1 full-store restore](docs/rag-restore-acceptance.md) is browser-verified through fresh-Redis replay, rebuild and natural cleanup; [M7c.2 native reference quality](docs/rag-reference-quality.md) is verified on its frozen FR/EN corpus; [M7c.3 capacity acceptance](docs/rag-capacity-acceptance.md) verifies a 2,000-child native generation and its dashboard journey; the full 100,000-child workload remains pending. [M7c.4 semantic interruption](docs/rag-interruption-acceptance.md) verifies one native worker-crash recovery through supplemental catalog, physical and dashboard checks; its original formal observer remains incomplete, and other stages/outages remain pending. A separate [light-profile capacity experiment](docs/rag-light-capacity-acceptance.md) completes a measured 2,000-child native pilot in 289,229 ms and its dashboard journey; its unchanged two-hour projection gate refuses the full run. Delivery evidence is recorded in the [build log](docs/build-task-log.md).

Create an account through the dashboard, then create an organization. To grant administration access to an existing account:

```sh
pnpm admin:grant your-email@example.com
```

## Included features

- Password and passkey authentication, password reset, TOTP two-factor authentication and recovery codes, session management, and account deletion.
- Organizations, members, invitations, and custom roles. Organization API-key permissions are intersected with the issuing member's current roles on every admission.
- Sign-in notifications: inbox, read/unread status, personal preferences, email, and Web Push. Workers process durable delivery receipts with bounded retries.
- A licensed feature catalog, an optional external provider, and explicit manual grants by a super administrator. Provider outages or expired entitlements never grant feature access.
- User and organization administration, organization suspension, permission management, and audit logging.
- Shared UI components, light/dark themes, and authentication flows translated into French, English, and Dutch.
- RAG catalog dashboard and APIs: encrypted S3/Ollama/Cohere/Voyage/OpenAI/Mistral credentials, groups, collection profiles with revision history and grants, scoped API keys, quota/usage views, and transactional audit. The admin panel edits organization quota overrides; the document library provides web upload, inspection, version replacement and deletion with durable cleanup.
- Native Ollama, Cohere, Voyage, OpenAI and Mistral indexing with versioned document-structure, token-window and semantic children, optional parent context, filtered FR/EN hybrid, lexical and vector search, and exact authorized source versions. The M4 implementation adds draft profile comparison, rebuild progress/retry/discard, catch-up, atomic activation and retained-generation cleanup while the serving index stays available.

The initial feature catalog is empty. No business domain or demo data is installed. The catalog migration adds empty RAG tables without granting existing API keys access.

Organization API keys remain separate from user sessions. Removed issuers, unbound historical keys and legacy full-access keys fail closed; they require supported scoped reissue rather than automatic attribution to another member. See [API-key authorization and reissue](docs/api-key-authorization.md) for the permission rule, compatibility behavior and dashboard acceptance recipe. Revocation applies to subsequent admissions and does not cancel requests already admitted.

Native [initial organization selection](docs/session-organization-selection.md) uses current active memberships and deterministic defaults while preserving valid native session rotations. The shared dashboard selector provides explicit loading, failure and no-active-organization recovery states; the guide records actual validation and delivery status.

## Repository structure

| Directory                                | Responsibility                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/web`                               | Dashboard, accounts, team, and notifications                                      |
| `apps/api`                               | HTTP transport, authentication, and OpenAPI documentation                         |
| `apps/admin`                             | Global administration protected by a superadmin session                           |
| `apps/workers`                           | Asynchronous notifications, document extraction, indexing and cleanup             |
| `packages/db`                            | Schema, generated client, and migrator image                                      |
| `packages/auth`                          | Better Auth and authorization policy                                              |
| `packages/api-contracts`                 | Versioned oRPC/Zod contracts                                                      |
| `packages/api`                           | Router composition                                                                |
| `packages/routers`                       | Organizations, members, RAG catalog, notifications, administration, and utilities |
| `packages/queues`, `packages/emails`     | Redis/BullMQ and email transports                                                 |
| `packages/ui`, `packages/dashboard-core` | Shared components                                                                 |

The API uses `/rpc/v1` and `/api/v1`. The current compatible contract revision is `1.19.0`. The OpenAPI schema is available at `/spec/v1.json` and `/spec.json`, and the version registry at `/api-versions.json`. `/health` checks the process; `/ready` checks PostgreSQL and Redis.

Cookie-authenticated RPC/REST requests using unsafe HTTP methods, including RPC POST reads, require a configured, trusted `Origin` or `Referer`. When both are absent, server and command-line clients must send `Vectorix-CSRF: orpc`; this public marker is not a credential and never overrides an explicitly rejected origin. Web and admin supply it automatically. Configure `TRUSTED_ORIGINS` as comma-separated exact HTTP(S) origins for your dashboards; add the API origin explicitly if Scalar should make cookie-authenticated mutations there. Keys and bearer clients without a Cookie header retain their authentication rules. See [cookie CSRF protection](docs/http-cookie-csrf.md) for deployment, client updates and verification. The API playground serves a locally packaged, exact-version Scalar bundle with a script-nonce CSP; see [playground security](docs/api-playground-security.md) for its same-origin policy and build/runtime boundaries.

Before auth and RPC/REST parsing, the API limits ordinary request bodies to 1 MiB and reserves a 26 MiB envelope for the four supported POST document upload/replacement routes. The original-file contract remains 25 MiB. The guard counts exposed stream bytes even when `Content-Length` is absent or understated; CORS preflight and bodyless adapter behavior remain unchanged. See [HTTP request limits](docs/http-request-limits.md) for route matching, sanitized 413 responses and deployment boundaries.

Matched RPC/REST procedure failures use bounded request-logger observations, and covered dashboard RPC errors use finite localized guidance with retry/account recovery. Permission codes and HTTP statuses remain authoritative; see [authorization errors and feedback](docs/api-authorization-errors.md) for scope, unchanged explicit service errors and actual acceptance status.

## Configuration

All variables are documented in `.env.example`. Public values are read on the server and passed to the interface, without `NEXT_PUBLIC_*` variables.

Web/admin builds share a framing policy (`frame-ancestors 'none'` and `X-Frame-Options: DENY`), MIME protection and `Referrer-Policy: no-referrer`. Preserve these headers at the reverse proxy and configure HSTS at HTTPS termination according to the deployment's domain policy. See [dashboard security headers](docs/dashboard-security-headers.md) for response boundaries, service-worker behavior and actual validation status.

Account registration and organization creation are enabled in the local example. Disable them with `ALLOW_ACCOUNT_CREATION=false` and `ALLOW_ORGANIZATION_CREATION=false` for an invitation-only deployment. Set URLs, trusted origins, secrets, the cookie domain, and WebAuthn settings for each deployment.

Email requires Resend or SMTP. Without a provider, notifications remain pending and fail after five attempts; users can still sign in. Account email verification and address changes require that platform mail configuration and a stable auth secret; organization credentials do not select account-security mail. SMTP supports an unauthenticated relay or a complete user/password pair, defaults to port 587 and uses only the SMTP sender when selected. A generic email-change acknowledgement is not delivery confirmation. See [Account email ownership](docs/account-email-ownership.md) for the implementation status and acceptance requirements. Web Push is disabled by default and requires a VAPID key pair and `ENCRYPTION_SECRET` for encrypted subscriptions. Web Push endpoints must use an approved native provider namespace, or an exact HTTPS origin from the operator's `VECTORIX_WEB_PUSH_ALLOWED_ORIGINS` override. The override replaces the native policy; leave it unset to use the defaults. API admission and each worker dispatch apply the same policy. Workers pin public DNS answers, verify TLS, refuse redirects, and bound requests and responses; private-network push services are unsupported. Invalid configuration blocks admission without mass-revoking existing devices, which remain removable through their saved receipts. See [Push destination policy](docs/notification-push-security.md) for boundaries and actual validation. These transports are not simulated in production.

Web and admin resolve `VECTORIX_TIME_ZONE` on the server at runtime and pass its validated value to their next-intl providers. Missing, empty or invalid values use `Europe/Brussels`; each user's language remains independent. Restart consumers after changing deployment configuration. See [Dashboard timezones](docs/dashboard-timezones.md) for the shared boundary, acceptance recipe and component-specific limits.

An explicit signed-in language choice in web/admin also saves the account's EN/FR/nl-BE preference. Anonymous choices affect only the display cookie. New native accounts default to English; historical preferences remain unchanged. Notifications normalize regional saved values such as `en-US`/`en-GB`, and email uses the recipient's current language at delivery. See [account and notification localization](docs/account-notification-localization.md) for precedence, historical snapshots and validation status.

Redis URL usernames and passwords must be percent-encoded once per component. The API and workers decode them once before connecting; a standalone `REDIS_PASSWORD` is a raw fallback only when the URL has no non-empty password. Invalid URL/credential encoding fails with a sanitized configuration error. See [Redis connections](docs/redis-connections.md) for precedence, examples and disposable authentication tests.

Password-reset links require a valid server-configured `VECTORIX_WEB_URL` (legacy `WEB_URL`/`APP_URL` remain lower-priority fallbacks when the preceding variables are empty). Set an explicit HTTP(S) base, with an optional served path prefix and no credentials, query or fragment. Missing or invalid selected configuration returns a sanitized 503 before account lookup or token creation; request headers and implicit localhost cannot choose a destination. Other sign-in flows remain available. See [Canonical password-reset links](docs/password-reset-links.md) for configuration, native reset boundaries and validation.

A license provider receives `GET {VECTORIX_FEATURE_PROVIDER_URL}/organizations/{id}/features` with an optional server token. It returns `{"features":{"reporting":true},"expiresAt":null}`. Cache duration and HTTP timeout are configurable. Manual mode, named `legacy` in the contract, requires explicit activation and grants in the administration interface.

RAG credentials resolve a complete organization configuration before the environment fallback. Configure `VECTORIX_DEFAULT_{S3,OLLAMA,COHERE,VOYAGE,OPENAI,MISTRAL}_*` as needed; an invalid organization configuration never falls back. Collection revisions retain their selected provider binding and destination. For OpenAI and Mistral, set `VECTORIX_DEFAULT_OPENAI_API_KEY` or `VECTORIX_DEFAULT_MISTRAL_API_KEY` with the matching `_ENDPOINT` base URL (`https://api.openai.com/v1` or `https://api.mistral.ai/v1`), or save an organization integration from the dashboard. Both require a non-empty API key. Initial indexing, rebuilds and vector/hybrid search support native Ollama, Cohere, Voyage, OpenAI and Mistral. Cohere requires a complete key/endpoint configuration with the provider root `https://api.cohere.com`, without `/v1` or `/v2`; `.env.example` supplies that root as the optional platform fallback. Voyage uses root endpoint `https://api.voyageai.com`, without `/v1`. OpenAI uses its complete API base including `/v1`; native execution supports the reviewed `text-embedding-3-small` and `text-embedding-3-large` models. Mistral uses complete API base `https://api.mistral.ai/v1`, the reviewed `mistral-embed`/`mistral-embed-2312` names, fixed 1024 dimensions and Generic input; its saved generation snapshot records the actually observed response model. Defaults are 20 collections, 5,000 documents, 25 MiB per original, 10 GiB retained storage, 100,000 active chunks and 100,000 temporary chunks per collection. `VECTORIX_DEFAULT_RAG_*` changes deployment defaults; `/api/v1/superadmin/organizations/{organizationId}/rag-quota` sets an organization override. The admin organization workspace exposes these effective quotas and overrides under **RAG quotas**. The document-library slice enforces original-size, document-count and storage limits, reserving capacity before upload. Failed extractions retain reservations until a successful retry or confirmed cleanup. Retained originals, extractions and reservations stay charged until durable cleanup removes their objects. Indexing enforces active, retained and reserved searchable-child accounting before vector writes. Parent context adds bounded application text/provenance storage; it is not embedded or counted as additional vectors.

### Document library setup

The library requires API, web, workers, PostgreSQL, Redis and a private S3 bucket. Start infrastructure with `docker compose up -d`, configure the complete `VECTORIX_DEFAULT_S3_*` fallback in `.env`, and run `pnpm dev`. Organization S3 integrations take precedence. Add their exact endpoints to `VECTORIX_S3_ALLOWED_ENDPOINTS` on **both API and workers**; the platform endpoint is allowed automatically. Existing documents retain their storage binding when the active integration changes.

S3 and embedding allowlists ignore malformed entries individually, so later approved destinations remain usable. Server warnings identify only the variable and one-based entry index. The current configuration replaces the previous cached snapshot; it never accumulates old approvals. See [endpoint matching and operator diagnostics](docs/rag-endpoint-allowlists.md) for URL rules and validation status.

The [S3 replacement extraction acceptance](docs/rag-s3-outage-acceptance.md) verifies five natural failed claims, retained previous catalog publication, same-store restoration and same-version retry through the production dashboard. The reusable isolated harness stays disabled by default. Physical cleanup outage recovery remains a separate scenario.

After deploying migration `20261024000000_document_ingestion`, open **Documents** in the dashboard. Upload non-empty UTF-8 `.txt`, `.md` or `.markdown` files of at most 25 MiB. Workers scan every five seconds; interrupted uploads can take five minutes to recover. Preview displays inert plain text in bounded pages. Downloads recheck authorization. Attach ready documents to collections you can manage. Configure the reverse proxy to accept at least 26 MiB request bodies and allow time for the S3 upload. S3 browser CORS is unnecessary because transfers go through the API. `VECTORIX_TIME_ZONE` controls dashboard date formatting at runtime (default: `Europe/Brussels`); each user’s language still controls the locale.

The PDF/DOCX worker needs `/usr/bin/pdfinfo`, `/usr/bin/pdftotext` and `/usr/bin/prlimit` on Linux (`poppler-utils` and `util-linux` on Debian/Ubuntu); the workers image installs these tools. Each rich upload reserves 10 MiB for its extraction artifact in addition to the original. Text-based PDFs retain physical pages, DOCX retains section/paragraph references, and scans report that OCR is unavailable. See [rich document limits and acceptance](docs/rag-rich-documents.md). No new migration is required for this extraction format.

Deploy the approved additive `20261025000000_document_lifecycle` migration before updating API/workers for replacement and deletion. Library managers can replace an original while the previous READY version stays published, inspect version history, or delete the document from every collection. Replacement defaults to seven days of old-version retention; deletion defaults to zero. Both accept 0–365 whole days, counted from the request. Deletion immediately revokes content access and has no restore action. **Deleted documents** exposes manager-only retained metadata, cleanup progress and failed-cleanup retry. Storage remains charged until private-object cleanup succeeds; zero days still waits out active index/source holds, unexpired source references and I/O safety windows. Archived version metadata keeps storage/credential references after purge. See [lifecycle behavior, safety windows and acceptance](docs/rag-document-lifecycle.md). M2a.2 is browser-verified; [M2b PDF/DOCX extraction](docs/rag-rich-documents.md) is implemented and browser-verified. The [first Ollama index and hybrid search journey](docs/rag-first-search.md) is implemented and browser-verified. M4 extends it with [profile changes and rebuilds](docs/rag-index-rebuild.md), M5a adds [native Cohere](docs/rag-cohere-embeddings.md), and M5b adds [native Voyage](docs/rag-voyage-embeddings.md), whose implementation and validation status are recorded in its guide. M5c OpenAI is implemented with automated validation and controlled dashboard acceptance complete. M5d Mistral is implemented with automated validation and controlled dashboard acceptance complete. M6a [token-window indexing](docs/rag-token-windows.md) is implemented and browser-verified; [M6b semantic indexing](docs/rag-semantic-planning.md) is implemented and browser-verified; [M6c parent/child context](docs/rag-parent-context.md) is implemented with automated checks and real Ollama browser acceptance complete. M7a [freshness and recovery](docs/rag-sync-freshness.md) and M7b.1 [current-work triage](docs/rag-operations.md) are implemented and browser-verified. M7b.2 [recorded activity](docs/rag-observability.md) is implemented and browser-verified; [M7c.1 full-store restore](docs/rag-restore-acceptance.md) is browser-verified through fresh-Redis replay, rebuild and natural cleanup; [native reference quality](docs/rag-reference-quality.md) is verified; full capacity and interrupted-process acceptance remain pending.

### First index and search setup

Deploy `20261026000000_rag_indexing`, run the vector infrastructure and workers, and configure an embedding-capable Ollama server or a complete Cohere/Voyage/OpenAI/Mistral binding. API uses the vector runtime role; workers also require the provisioning role. Organization endpoints must appear in `VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS` on both services; each provider’s complete platform endpoint is approved for that provider automatically. The dashboard lists models for the saved provider binding, verifies the saved preset/dimensions, starts a durable index, inspects chunks and tests filtered hybrid/lexical/vector retrieval with exact authorized sources. It does not install models. Choose the explicit EmbeddingGemma preset when using that model.

For the exact CPU-only Docker setup, model installation, native probes, organization credentials and reproducible live test, see [Ollama and EmbeddingGemma tests](docs/rag-ollama-embeddinggemma.md). The guide records the executed version/digest, explains host versus container addresses, and separates real model checks from controlled failure fixtures and capacity benchmarks.

For Cohere, use the **Generic** preset and a supported model/dimension choice from the collection form. Discovery and verification are tied to the saved revision; changing the unsaved provider or model cannot reuse the old provider’s discovered models. The probe labels Cohere’s identity as a capability-profile fingerprint, which cannot verify hosted model weights. See [Cohere configuration, native roles and validation status](docs/rag-cohere-embeddings.md). Controlled HTTP/dashboard checks do not establish live paid-service connectivity; that verification remains pending.

For Voyage, use root endpoint `https://api.voyageai.com`, **Generic**, a reviewed `voyage-4` model and 256/512/1024/2048 dimensions. Choose DiskANN at 2048 dimensions. **View reviewed models** reads a local catalog without contacting Voyage or validating credentials; **Verify saved model** makes actual native document/query probes. Hosted identity remains a capability fingerprint. See [Voyage setup, native protocol and validation status](docs/rag-voyage-embeddings.md); live paid-provider verification remains pending.

For OpenAI, use complete API base `https://api.openai.com/v1`, **Generic**, and a whole-number dimension in the reviewed range: 1–1536 for `text-embedding-3-small`, or 1–3072 for `text-embedding-3-large`. Discovery contacts the native model catalog but does not verify embeddings; the saved-profile probe checks the chosen size. Use DiskANN above 2,000 dimensions. See [OpenAI native protocol, configuration and validation status](docs/rag-openai-embeddings.md). Live paid-provider verification remains pending.

For Mistral, use **Generic**, fixed **1024 dimensions**, and reviewed `mistral-embed` or `mistral-embed-2312`. Discovery reads the native model catalog; actual verification checks both application paths and displays the selected and observed response model IDs. The saved observed ID must remain stable. The displayed 8000-token processing budget is conservative Vectorix policy for the documented 8k context. See [Mistral protocol, configuration and validation status](docs/rag-mistral-embeddings.md); live paid-provider verification remains pending.

Indexing executes Ollama, Cohere, Voyage, OpenAI or Mistral document-structure, token-window or semantic profiles with optional parent context. Other saved profiles remain inspectable drafts. Document updates and metadata changes catch up asynchronously while the old publication remains available. Source holds keep exact indexed originals/extractions available during catch-up and bounded source-receipt retention. Delete RAG collections/documents and wait for physical cleanup before deleting an organization. See [architecture, limits, acceptance and validation status](docs/rag-first-search.md).

### Semantic chunking (M6b)

The semantic path is implemented; automated validation and real Ollama production-dashboard acceptance are complete. See [its protocol, limits and acceptance record](docs/rag-semantic-planning.md). Deploy the approved additive `20261028000000_rag_semantic` migration before these API/workers. Choose **Semantic**, save a percentile and verify the saved native embedding profile. Boundary embeddings use the same document role, preparation, title and credential binding as final chunks. Planning yields after at most 32 units per claim, preserving accepted distances and a sealed retry plan.

Separate defaults are 8,192 useful units, 1 MiB planning payload per document and 64 MiB stored/reserved planning payload per organization. A candidate reserves a lifetime allowance of 128 MiB prepared input and 4,096 logical batches across boundary/final embeddings. Organization outstanding caps are 512 MiB and 16,384 batches. These are technical capacity/work limits, not prices or monthly credits. The seven corresponding `VECTORIX_DEFAULT_RAG_{SEMANTIC,EMBEDDING}_*` variables are listed in `.env.example`; organization overrides use the separate admin semantic policy at `/api/v1/superadmin/organizations/{organizationId}/semantic-quota`.

Temporary capacity contention waits without spending failure retries. Bounded priority lets existing reservation holders progress through a fresh backlog while preserving ordinary task slots. Raising policy caps does not force active holders to enlarge their reservations. Hard limits produce an explicit failure; retry retains already dispatched work, and actual stored planning payload stays charged until cleanup. Dashboard usage distinguishes dispatch intent, confirmed selected usage, missing native counts and unresolved attempts. It covers semantic indexing only, not previous calls or query embeddings. Native transport retries and Ollama manifest requests are not separate billed-request observations. The [build log](docs/build-task-log.md) records completed automated checks and actual production-dashboard verification separately.

### Parent context (M6c)

Deploy the approved additive `20261029000000_rag_parent_context` migration, then update and drain all API/worker readers before enabling parent profiles. Older cleanup workers reconstruct manifests from all rows and cannot safely handle newly materialized parents. Enable **Search child passages and return parent context** with any supported child strategy and native provider. Save the maximum parent size, verify the saved embedding profile, and index or review a rebuild.

The saved `parent-context-utf8-v1` descriptor is separate from the unchanged child algorithm. Parents retain exact canonical text and source spans. The complete application layout is sealed before external child-vector publication; only children are embedded, ranked and counted against passage quotas. Parent context adds bounded application storage. Search groups the bounded child candidate window before final `topK`, keeps each representative child's scores and exact-source receipt, and displays optional collapsed context. Preview pagination stays child-only; context hydration projects at most 64 source spans per row inside PostgreSQL. A separate underfill hint means the bounded window found fewer distinct parents, not that the corpus is exhausted.

Automated validation is complete, including all 206 HTTP/catalog tests and six container images. Real Ollama dashboard acceptance is complete; its recorded results, limits and rollout instructions are in the [parent-context guide](docs/rag-parent-context.md) and [build log](docs/build-task-log.md). Delivered in [PR #40](https://github.com/SimonLoir/vectorix/pull/40), squash-merged after both exact-head checks passed. Controlled hosted-provider fixtures do not establish paid-service connectivity or relevance/load acceptance.

### Collection synchronization recovery (M7a)

The application provides configured automatic synchronization and an explicit **Adopt synchronization** action. New indexes save their accepting manager as controller for later shared-library changes. Current membership and collection management rights are rechecked before work; a pending rebuild also needs profile administration. Historical null-controller generations retain their event-actor behavior until adoption; an initial provisioning/indexing retry also preserves its established activation-authority transfer.

Adoption fences current runnable task leases and binds them to the adopting manager without resetting progress or usage. Failed work keeps its separate task retry. The dashboard adds desired/indexed versions, current freshness and authorized document retry. No new configuration or migration is needed. Compatible API revision 1.16.0, automated validation and real Ollama dashboard acceptance are complete. See the [synchronization policy and acceptance status](docs/rag-sync-freshness.md). This is not a claim that M7 operational readiness is complete.

### Organization operations triage (M7b.1)

The Operations page adds a bounded view of current ingestion, indexing and cleanup across the organization, with current-access links to existing recovery screens and technical totals in admin. It reuses durable task state without a migration. Compatible API revision 1.17.0, automated validation and real Ollama dashboard acceptance are complete. Acceptance age includes queue wait, backoff and retries; scheduled cleanup and processing claims do not establish worker health. See the [operations scope and acceptance](docs/rag-operations.md). Historical recorded activity, phase latency and shared worker observations are implemented in M7b.2 below.

### Recorded activity and worker observations (M7b.2)

Deploy the approved additive `20261030000000_rag_observability` migration before updating API/workers. Organization sessions with `ragQuota.read` can inspect **Usage and quotas → Recorded activity** across 24/168/720 hourly buckets; admin organization workspaces show the same technical totals. The admin dashboard separately shows recent/stale/never-observed shared worker lanes. No new environment variable or external service is required.

These bounded best-effort aggregates cover extraction, all three indexing strategies and lexical/vector/hybrid search. They exclude query text, content and resource identifiers; native probes/discovery are excluded. Unknown native/billed usage and missing observations stay explicit. They do not replace quotas, semantic work accounting, current Operations, billing or readiness checks. Upgrade both API and workers before interpreting tracking coverage. Automated validation and real Ollama dashboard acceptance are complete; see [observation boundaries, deployment and actual evidence](docs/rag-observability.md). [M7c.1 full-store restoration](docs/rag-restore-acceptance.md), durable replay, rebuild and natural cleanup are verified. Native reference quality is verified; full capacity and interrupted-process acceptance remain M7c.

### Rebuild an active collection

Deploy the approved additive `20261027000000_rag_rebuild` migration before the M4 API/workers. Save a new collection profile as a draft, then select **Review and rebuild** in its indexing section. The confirmation shows the full serving and replacement profiles. Saving alone never changes the profile used for searches. Keep the serving model, credentials and vector destination available through its in-flight request grace and retained-generation cleanup.

Rebuild and discard require a current session, organization profile-update/document-management permissions and both explicit collection administration and document-management grants. While a candidate is building or failed, its profile remains fixed; name and description can still change. Inspect generation-specific chunks, task failures and retry or discard a candidate from the dashboard. A failed candidate leaves the serving generation available.

Changes to source versions, associations and metadata reach each live generation before activation. Search filters use the serving generation’s declarations; metadata edits use the latest saved profile. Shared field types cannot change while a non-cleaned generation retains the old type. Activation atomically switches the pointer and passage accounting. Results captured before the switch retain their generation and bounded exact-source references, subject to current access.

At most two non-cleaned vector tables are admitted per collection and one rebuild candidate per organization. A failed or discarded candidate and a retired table continue consuming capacity until physical cleanup is acknowledged; another build must wait. The previous serving generation retains its existing request/source grace before cleanup. See [M4 runtime boundaries and acceptance status](docs/rag-index-rebuild.md) for the current implementation and validation record; completed browser acceptance and PR delivery are tracked there and in the build log. M5a adds Cohere and M5b adds Voyage to the same rebuild flow; controlled Voyage dashboard acceptance is complete. M5c OpenAI is implemented with automated validation and controlled dashboard acceptance complete; M5d Mistral is implemented with automated validation and controlled dashboard acceptance complete. M6a [token-window indexing](docs/rag-token-windows.md) is implemented and browser-verified; [M6b semantic indexing](docs/rag-semantic-planning.md) is implemented and browser-verified; [M6c parent/child context](docs/rag-parent-context.md) is implemented with automated checks and real Ollama browser acceptance complete. M7a [freshness and recovery](docs/rag-sync-freshness.md) and M7b.1 [current-work triage](docs/rag-operations.md) are implemented and browser-verified. M7b.2 [recorded activity](docs/rag-observability.md) is implemented and browser-verified; [M7c.1 full-store restore](docs/rag-restore-acceptance.md) is browser-verified through fresh-Redis replay, rebuild and natural cleanup; [native reference quality](docs/rag-reference-quality.md) is verified; full capacity and interrupted-process acceptance remain pending.

## Validation

```sh
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

`pnpm test:catalog` starts disposable application/vector PostgreSQL, Redis and private RustFS containers on random loopback ports, tests a fresh install and upgrade from the initial schema, repeats deployment, checks schema parity and existing records, runs the core and RAG API journeys, then removes its containers and volumes. It does not load `.env` or start application servers. The “Catalog checks” GitHub Actions workflow runs it on pull requests and `main`, alongside schema, type, lint, and unit checks.

Deploy the approved `20261031000000_sql_function_search_path` migration before capturing a new corrected backup baseline. It pins the trusted lookup path of the 28 existing application functions so populated CHECK validators resolve their helpers during ordinary PostgreSQL restoration. See [the SQL correction and populated regression](docs/rag-sql-function-restore.md).

`pnpm test:restore:guards` runs the isolated restore tool's pure file/mocked-resource checks without starting containers, databases or a model. The separately invoked [full-store restore workflow](tests/acceptance/restore/README.md) uses bounded synthetic dashboard data and fresh owned volumes; its [actual acceptance record](docs/rag-restore-acceptance.md) distinguishes the completed restore/replay/rebuild/cleanup observations from remaining quality/load work. It is not a production backup scheduler or a capacity benchmark.

`pnpm test:quality:guards` runs pure frozen-corpus scoring and mocked adapter/resource checks, with no HTTP, database, container or model calls. The separately invoked [native reference-quality workflow](tests/acceptance/quality/README.md) uses fresh owned resources and normal production APIs. Its [actual record](docs/rag-reference-quality.md) covers 720 scored searches, exact sources, access controls and selected dashboard checks; this small artificial corpus does not establish ANN recall or the 100,000-child load target.

`pnpm test:capacity:guards` runs the separate capacity tooling’s pure/injected checks. The explicit [native capacity workflow](tests/acceptance/capacity/README.md) owns fresh resources and freezes its corpus, profile and finite gates before measurement. [Actual results](docs/rag-capacity-acceptance.md) establish a 2,000-child generation and functional dashboard checks through supplemental read-only proof after a formal observer failure. They do not grant admission to the full 100,000-child/ten-concurrent-search test or establish internal p95.

`pnpm test:s3-outage:guards` runs the S3 ingestion fault harness's pure/injected checks and syntax validation without starting stores, processes or network operations. The catalog workflow includes this command. The separately activated [native recovery scenario](docs/rag-s3-outage-acceptance.md) records one verified production-dashboard trial; offline checks alone cannot establish that journey.

`pnpm test:queues` owns a separate loopback Redis with authentication, verifies all three queues/workers and their schedulers using encoded ACL credentials and a raw standalone password, then removes its container. It does not read `.env`; the catalog workflow runs it before the database journeys. Its live connection is plaintext loopback, while `rediss:` options are covered by unit tests.

To run the integration suites manually, they require a separate database whose name ends in `_test`. The runner owns and destroys its complete disposable databases and private bucket; retained fixtures are not fabricated as physically cleaned. Native embedding HTTP fixtures are controlled test servers, not live external provider validation. Build the vector image first with `docker build -f infra/postgres-vector/Dockerfile -t pxdv.be/vectorix/postgres-vector:local .`, or set `VECTOR_POSTGRES_IMAGE` to an already built test image.

```sh
docker compose exec postgres createdb -U postgres vectorix_test
DATABASE_URL=postgresql://postgres:password@localhost:5432/vectorix_test pnpm --filter @repo/db migrate:deploy
DATABASE_URL=postgresql://postgres:password@localhost:5432/vectorix_test pnpm exec dotenvx run -f .env -- pnpm --filter api test:integration
```

## Deployment and migrations

The initial migration creates the application foundation; the second adds the RAG catalog. For subsequent changes, edit the schema, generate and review a development migration with `pnpm --filter @repo/db migrate:dev`, then run `pnpm db:migrate` before deploying the applications. Do not use `db:push` against a production database.

```sh
docker build -f apps/web/Dockerfile -t pxdv.be/vectorix/web:latest .
docker build -f apps/api/Dockerfile -t pxdv.be/vectorix/api:latest .
docker build -f apps/admin/Dockerfile -t pxdv.be/vectorix/admin:latest .
docker build -f apps/workers/Dockerfile -t pxdv.be/vectorix/workers:latest .
docker build -f packages/db/Dockerfile -t pxdv.be/vectorix/migrator:latest .
docker build -f infra/postgres-vector/Dockerfile -t pxdv.be/vectorix/postgres-vector:latest .
```

Inject configuration when containers start and use PostgreSQL and Redis DNS names reachable from their network. The migrator is a one-off process that runs `prisma migrate deploy`. It does not run alongside the applications in `pnpm dev`.

Each application has its own Dockerfile, with the repository root as the build context. Web and admin run the Next.js standalone server and include its traced files, static assets, and, for web, the public directory. The API and workers include their bundles and production dependencies isolated by `pnpm deploy` from the lockfile. Optional dependencies are excluded from these two images to avoid Next.js/TypeScript peers and unused native accelerators; PostgreSQL and BullMQ use their JavaScript implementations.

All five application images use Node.js 24 Alpine and an unprivileged user. pnpm and compilation tools remain in build stages. Prisma generation is required: any failure stops the build. No private configuration is copied into the images.

To build and test all five application images and the vector image with isolated PostgreSQL, Redis, and RustFS services:

```sh
pnpm test:docker
# Alternatively, with only Bash and Docker installed:
bash scripts/test-docker.sh
# Run only infrastructure checks (also builds the migrator when needed):
pnpm test:infra
```

This test checks migrations, startup, API registration, Next.js assets, runtime configuration, worker job execution, and the absence of build tools in backend images. It also verifies real vector indexes, database role boundaries, private S3 object operations, and persistence after restart. It publishes no host ports and cleans up its test resources afterward. The GitHub Actions “Docker images” workflow runs the same test on every push to `main` and on pull requests.

### Image registry

The registry is `pxdv.be`, with repositories `vectorix/web`, `vectorix/admin`, `vectorix/api`, `vectorix/workers`, `vectorix/migrator`, and `vectorix/postgres-vector`. After successful tests on `main`, the workflow publishes the exact images just tested with `sha-<full Git SHA>` and `latest` tags. Pull requests run tests only.

Configure the GitHub Actions secrets `PXDV_REGISTRY_USERNAME` and `PXDV_REGISTRY_PASSWORD` with an account authorized to publish to all six repositories. While either secret is missing, tests remain enabled and publication is skipped with a warning. Once the secrets are configured, rerun the “Docker images” workflow on `main` or push a new commit to publish images.

To retrieve a published version:

```sh
docker login pxdv.be
docker pull pxdv.be/vectorix/web:latest
# For a reproducible deployment, use the same sha-<SHA> tag for all six built images.
```

## Contributing

Implement changes on a dedicated `codex/*` branch and open a pull request against `main`. Do not push implementation commits directly to `main`. Merge only after review and an explicit approval to merge.

## Documentation

- [Repository conventions](AGENTS.md): architecture, authorization, API compatibility, development, and validation rules.
- [Dashboard timezones](docs/dashboard-timezones.md): shared server validation, public provider configuration and locale-independent runtime dates.
- [Superadmin transactions](docs/superadmin-transactions.md): atomic mutations/audits, current actor checks, audit address provenance and remaining native owner-guard work.
- [Redis connections](docs/redis-connections.md): encoded URL credentials, raw fallback precedence and isolated queue/worker acceptance.
- [Canonical password-reset links](docs/password-reset-links.md): server-only destinations, strict configuration precedence and reset-request acceptance.
- [HTTP request limits](docs/http-request-limits.md): pre-parser body budgets, upload exceptions, actual-byte counting and acceptance.
- [API-key authorization](docs/api-key-authorization.md): current issuer permissions, key/session separation, historical key reissue and role-revocation acceptance.
- [RAG catalog and access](docs/rag-catalog-access.md): implemented backend foundation, schema, credentials, authorization, quotas, validation, and outstanding dashboard checklist.
- [RAG infrastructure](docs/rag-infrastructure.md): phase 1 services, connection settings, role boundaries, and isolated acceptance tests.
- [RAG implementation plan](docs/rag-implementation-plan.md): agreed V1 scope, architecture diagrams, proposed defaults, implementation status and dashboard acceptance scenarios. M1–M3 are implemented; M4 is implemented and browser-verified; M5a is implemented with controlled acceptance complete; M5b is implemented with controlled dashboard acceptance complete. M5c OpenAI is implemented with automated validation and controlled dashboard acceptance complete. M5d Mistral is implemented with automated validation and controlled dashboard acceptance complete. M6a token-window indexing is implemented and browser-verified; M6b semantic indexing is implemented with automated validation and real Ollama dashboard acceptance complete. M6c parent/child context is implemented with automated validation and real Ollama browser acceptance complete. M7a freshness/recovery, M7b.1 current-work triage and M7b.2 recorded activity are implemented and browser-verified. M7c.1 full-store restore/replay/rebuild/natural cleanup is verified. Native reference quality is verified. The 2,000-child native pilot and dashboard journey are verified separately; full capacity, interrupted-process acceptance and live paid-provider verification stay pending.
- [Document library](docs/rag-document-library.md): upload, extraction, preview, original download and collection associations.
- [Document lifecycle](docs/rag-document-lifecycle.md): version replacement, deletion, retention, index/source holds, private-object cleanup and dashboard acceptance.
- [PDF cross-reference recovery](docs/rag-pdf-recovery.md): narrow native diagnostic acceptance, unchanged source geometry and recorded validation status.
- [First collection index and search](docs/rag-first-search.md): native Ollama, durable publication, filtered hybrid retrieval, exact sources and recorded M3 acceptance.
- [Profile changes and rebuilds](docs/rag-index-rebuild.md): draft/serving profiles, catch-up, atomic activation, candidate recovery, physical cleanup and M4 acceptance status.
- [Semantic indexing](docs/rag-semantic-planning.md): canonical boundary plans, native-batch usage, technical quotas, retry/cleanup safeguards and current dashboard acceptance.
- [Parent context](docs/rag-parent-context.md): saved parent layout, child-only indexing, bounded context retrieval, rollout requirements and M6c acceptance.
- [Build and validation log](docs/build-task-log.md): completed template work and recorded checks.
