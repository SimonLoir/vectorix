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

The vector database uses PostgreSQL 18.6 with pgvector 0.8.7 and pgvectorscale 0.9.1. RustFS 1.0.3 provides a private document bucket initialized by the one-off `s3-init` service. Each database and object store has its own named volume. Existing `.env` files need the new vector/S3 settings from `.env.example`; `setup:env` preserves existing files. See [RAG infrastructure](docs/rag-infrastructure.md) for connection roles, setup, and upgrade behavior. The [catalog and access APIs](docs/rag-catalog-access.md) and [catalog dashboard](docs/rag-dashboard.md) are implemented. Configure integrations, collection profiles, groups, grants, and scoped keys from the dashboard; inspect usage and audit there, and edit organization quotas in the admin panel. The [TXT/Markdown library](docs/rag-document-library.md) provides private upload, background extraction, preview, authenticated original download and collection associations. The [document lifecycle](docs/rag-document-lifecycle.md) adds replacement, deletion, retention delays and durable cleanup; M2a.2 is implemented and browser-verified. The [PDF/DOCX extraction slice](docs/rag-rich-documents.md) and [first Ollama index/search journey](docs/rag-first-search.md) are implemented and browser-verified. [Profile changes and rebuilds](docs/rag-index-rebuild.md) are implemented and browser-verified. [Native Cohere embeddings](docs/rag-cohere-embeddings.md) are implemented with controlled dashboard acceptance complete. [Native Voyage embeddings](docs/rag-voyage-embeddings.md) are implemented with automated validation complete and controlled dashboard acceptance complete. Live paid-provider verification remains pending for both. Delivery evidence is recorded in the [build log](docs/build-task-log.md).

Create an account through the dashboard, then create an organization. To grant administration access to an existing account:

```sh
pnpm admin:grant your-email@example.com
```

## Included features

- Password and passkey authentication, password reset, TOTP two-factor authentication and recovery codes, session management, and account deletion.
- Organizations, members, invitations, and custom roles. Permissions are rechecked by the API; API keys are restricted to explicit permissions.
- Sign-in notifications: inbox, read/unread status, personal preferences, email, and Web Push. Workers process durable delivery receipts with bounded retries.
- A licensed feature catalog, an optional external provider, and explicit manual grants by a super administrator. Provider outages or expired entitlements never grant feature access.
- User and organization administration, organization suspension, permission management, and audit logging.
- Shared UI components, light/dark themes, and authentication flows translated into French, English, and Dutch.
- RAG catalog dashboard and APIs: encrypted S3/Ollama/Cohere/Voyage/OpenAI/Mistral credentials, groups, collection profiles with revision history and grants, scoped API keys, quota/usage views, and transactional audit. The admin panel edits organization quota overrides; the document library provides web upload, inspection, version replacement and deletion with durable cleanup.
- Native Ollama, Cohere and Voyage indexing with document-structure chunks, filtered FR/EN hybrid, lexical and vector search, and exact authorized source versions. The M4 implementation adds draft profile comparison, rebuild progress/retry/discard, catch-up, atomic activation and retained-generation cleanup while the serving index stays available.

The initial feature catalog is empty. No business domain or demo data is installed. The catalog migration adds empty RAG tables without granting existing API keys access.

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

The API uses `/rpc/v1` and `/api/v1`. The current compatible contract revision is `1.10.0`. The OpenAPI schema is available at `/spec/v1.json` and `/spec.json`, and the version registry at `/api-versions.json`. `/health` checks the process; `/ready` checks PostgreSQL and Redis.

## Configuration

All variables are documented in `.env.example`. Public values are read on the server and passed to the interface, without `NEXT_PUBLIC_*` variables.

Account registration and organization creation are enabled in the local example. Disable them with `ALLOW_ACCOUNT_CREATION=false` and `ALLOW_ORGANIZATION_CREATION=false` for an invitation-only deployment. Set URLs, trusted origins, secrets, the cookie domain, and WebAuthn settings for each deployment.

Email requires Resend or SMTP. Without a provider, notifications remain pending and fail after five attempts; users can still sign in. Web Push is disabled by default and requires a VAPID key pair and `ENCRYPTION_SECRET` for encrypted subscriptions. These transports are not simulated in production.

A license provider receives `GET {VECTORIX_FEATURE_PROVIDER_URL}/organizations/{id}/features` with an optional server token. It returns `{"features":{"reporting":true},"expiresAt":null}`. Cache duration and HTTP timeout are configurable. Manual mode, named `legacy` in the contract, requires explicit activation and grants in the administration interface.

RAG credentials resolve a complete organization configuration before the environment fallback. Configure `VECTORIX_DEFAULT_{S3,OLLAMA,COHERE,VOYAGE,OPENAI,MISTRAL}_*` as needed; an invalid organization configuration never falls back. Collection revisions retain their selected provider binding and destination. For OpenAI and Mistral, set `VECTORIX_DEFAULT_OPENAI_API_KEY` or `VECTORIX_DEFAULT_MISTRAL_API_KEY` with the matching `_ENDPOINT` base URL (`https://api.openai.com/v1` or `https://api.mistral.ai/v1`), or save an organization integration from the dashboard. Both require a non-empty API key. Initial indexing, rebuilds and vector/hybrid search support native Ollama, Cohere and Voyage. Cohere requires a complete key/endpoint configuration with the provider root `https://api.cohere.com`, without `/v1` or `/v2`; `.env.example` supplies that root as the optional platform fallback. Voyage uses root endpoint `https://api.voyageai.com`, without `/v1`. OpenAI and Mistral execution remains planned in M5c–M5d; their saved credentials do not enable indexing. Defaults are 20 collections, 5,000 documents, 25 MiB per original, 10 GiB retained storage, 100,000 active chunks and 100,000 temporary chunks per collection. `VECTORIX_DEFAULT_RAG_*` changes deployment defaults; `/api/v1/superadmin/organizations/{organizationId}/rag-quota` sets an organization override. The admin organization workspace exposes these effective quotas and overrides under **RAG quotas**. The document-library slice enforces original-size, document-count and storage limits, reserving capacity before upload. Failed extractions retain reservations until a successful retry or confirmed cleanup. Retained originals, extractions and reservations stay charged until durable cleanup removes their objects. Indexing enforces active, retained and reserved chunk accounting before vector writes.

### Document library setup

The library requires API, web, workers, PostgreSQL, Redis and a private S3 bucket. Start infrastructure with `docker compose up -d`, configure the complete `VECTORIX_DEFAULT_S3_*` fallback in `.env`, and run `pnpm dev`. Organization S3 integrations take precedence. Add their exact endpoints to `VECTORIX_S3_ALLOWED_ENDPOINTS` on **both API and workers**; the platform endpoint is allowed automatically. Existing documents retain their storage binding when the active integration changes.

After deploying migration `20261024000000_document_ingestion`, open **Documents** in the dashboard. Upload non-empty UTF-8 `.txt`, `.md` or `.markdown` files of at most 25 MiB. Workers scan every five seconds; interrupted uploads can take five minutes to recover. Preview displays inert plain text in bounded pages. Downloads recheck authorization. Attach ready documents to collections you can manage. Configure the reverse proxy to accept at least 26 MiB request bodies and allow time for the S3 upload. S3 browser CORS is unnecessary because transfers go through the API. `VECTORIX_TIME_ZONE` controls dashboard date formatting at runtime (default: `Europe/Brussels`); each user’s language still controls the locale.

The PDF/DOCX worker needs `/usr/bin/pdfinfo`, `/usr/bin/pdftotext` and `/usr/bin/prlimit` on Linux (`poppler-utils` and `util-linux` on Debian/Ubuntu); the workers image installs these tools. Each rich upload reserves 10 MiB for its extraction artifact in addition to the original. Text-based PDFs retain physical pages, DOCX retains section/paragraph references, and scans report that OCR is unavailable. See [rich document limits and acceptance](docs/rag-rich-documents.md). No new migration is required for this extraction format.

Deploy the approved additive `20261025000000_document_lifecycle` migration before updating API/workers for replacement and deletion. Library managers can replace an original while the previous READY version stays published, inspect version history, or delete the document from every collection. Replacement defaults to seven days of old-version retention; deletion defaults to zero. Both accept 0–365 whole days, counted from the request. Deletion immediately revokes content access and has no restore action. **Deleted documents** exposes manager-only retained metadata, cleanup progress and failed-cleanup retry. Storage remains charged until private-object cleanup succeeds; zero days still waits out active index/source holds, unexpired source references and I/O safety windows. Archived version metadata keeps storage/credential references after purge. See [lifecycle behavior, safety windows and acceptance](docs/rag-document-lifecycle.md). M2a.2 is browser-verified; [M2b PDF/DOCX extraction](docs/rag-rich-documents.md) is implemented and browser-verified. The [first Ollama index and hybrid search journey](docs/rag-first-search.md) is implemented and browser-verified. M4 extends it with [profile changes and rebuilds](docs/rag-index-rebuild.md), M5a adds [native Cohere](docs/rag-cohere-embeddings.md), and M5b adds [native Voyage](docs/rag-voyage-embeddings.md), whose implementation and validation status are recorded in its guide. M5c–M5d providers, M6 chunking/context and M7 operational acceptance remain planned.

### First index and search setup

Deploy `20261026000000_rag_indexing`, run the vector infrastructure and workers, and configure an embedding-capable Ollama server or a complete Cohere/Voyage binding. API uses the vector runtime role; workers also require the provisioning role. Organization endpoints must appear in `VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS` on both services; each provider’s complete platform endpoint is approved for that provider automatically. The dashboard lists models for the saved provider binding, verifies the saved preset/dimensions, starts a durable index, inspects chunks and tests filtered hybrid/lexical/vector retrieval with exact authorized sources. It does not install models. Choose the explicit EmbeddingGemma preset when using that model.

For the exact CPU-only Docker setup, model installation, native probes, organization credentials and reproducible live test, see [Ollama and EmbeddingGemma tests](docs/rag-ollama-embeddinggemma.md). The guide records the executed version/digest, explains host versus container addresses, and separates real model checks from controlled failure fixtures and capacity benchmarks.

For Cohere, use the **Generic** preset and a supported model/dimension choice from the collection form. Discovery and verification are tied to the saved revision; changing the unsaved provider or model cannot reuse the old provider’s discovered models. The probe labels Cohere’s identity as a capability-profile fingerprint, which cannot verify hosted model weights. See [Cohere configuration, native roles and validation status](docs/rag-cohere-embeddings.md). Controlled HTTP/dashboard checks do not establish live paid-service connectivity; that verification remains pending.

For Voyage, use root endpoint `https://api.voyageai.com`, **Generic**, a reviewed `voyage-4` model and 256/512/1024/2048 dimensions. Choose DiskANN at 2048 dimensions. **View reviewed models** reads a local catalog without contacting Voyage or validating credentials; **Verify saved model** makes actual native document/query probes. Hosted identity remains a capability fingerprint. See [Voyage setup, native protocol and validation status](docs/rag-voyage-embeddings.md); live paid-provider verification remains pending.

Indexing executes Ollama, Cohere or Voyage document-structure profiles without parent/child expansion. Other saved profiles remain inspectable drafts. Document updates and metadata changes catch up asynchronously while the old publication remains available. Source holds keep exact indexed originals/extractions available during catch-up and bounded source-receipt retention. Delete RAG collections/documents and wait for physical cleanup before deleting an organization. See [architecture, limits, acceptance and validation status](docs/rag-first-search.md).

### Rebuild an active collection

Deploy the approved additive `20261027000000_rag_rebuild` migration before the M4 API/workers. Save a new collection profile as a draft, then select **Review and rebuild** in its indexing section. The confirmation shows the full serving and replacement profiles. Saving alone never changes the profile used for searches. Keep the serving model, credentials and vector destination available through its in-flight request grace and retained-generation cleanup.

Rebuild and discard require a current session, organization profile-update/document-management permissions and both explicit collection administration and document-management grants. While a candidate is building or failed, its profile remains fixed; name and description can still change. Inspect generation-specific chunks, task failures and retry or discard a candidate from the dashboard. A failed candidate leaves the serving generation available.

Changes to source versions, associations and metadata reach each live generation before activation. Search filters use the serving generation’s declarations; metadata edits use the latest saved profile. Shared field types cannot change while a non-cleaned generation retains the old type. Activation atomically switches the pointer and passage accounting. Results captured before the switch retain their generation and bounded exact-source references, subject to current access.

At most two non-cleaned vector tables are admitted per collection and one rebuild candidate per organization. A failed or discarded candidate and a retired table continue consuming capacity until physical cleanup is acknowledged; another build must wait. The previous serving generation retains its existing request/source grace before cleanup. See [M4 runtime boundaries and acceptance status](docs/rag-index-rebuild.md) for the current implementation and validation record; completed browser acceptance and PR delivery are tracked there and in the build log. M5a adds Cohere and M5b adds Voyage to the same rebuild flow; controlled Voyage dashboard acceptance is complete. M5c–M5d providers, M6 chunking/context modes and M7 operational acceptance remain planned.

## Validation

```sh
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

`pnpm test:catalog` starts disposable application/vector PostgreSQL, Redis and private RustFS containers on random loopback ports, tests a fresh install and upgrade from the initial schema, repeats deployment, checks schema parity and existing records, runs the core and RAG API journeys, then removes its containers and volumes. It does not load `.env` or start application servers. The “Catalog checks” GitHub Actions workflow runs it on pull requests and `main`, alongside schema, type, lint, and unit checks.

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
- [RAG catalog and access](docs/rag-catalog-access.md): implemented backend foundation, schema, credentials, authorization, quotas, validation, and outstanding dashboard checklist.
- [RAG infrastructure](docs/rag-infrastructure.md): phase 1 services, connection settings, role boundaries, and isolated acceptance tests.
- [RAG implementation plan](docs/rag-implementation-plan.md): agreed V1 scope, architecture diagrams, proposed defaults, implementation status and dashboard acceptance scenarios. M1–M3 are implemented; M4 is implemented and browser-verified; M5a is implemented with controlled acceptance complete; M5b is implemented with controlled dashboard acceptance complete. Live paid-provider verification and M5c–M5d/M6/M7 remain pending.
- [Document library](docs/rag-document-library.md): upload, extraction, preview, original download and collection associations.
- [Document lifecycle](docs/rag-document-lifecycle.md): version replacement, deletion, retention, index/source holds, private-object cleanup and dashboard acceptance.
- [First collection index and search](docs/rag-first-search.md): native Ollama, durable publication, filtered hybrid retrieval, exact sources and recorded M3 acceptance.
- [Profile changes and rebuilds](docs/rag-index-rebuild.md): draft/serving profiles, catch-up, atomic activation, candidate recovery, physical cleanup and M4 acceptance status.
- [Build and validation log](docs/build-task-log.md): completed template work and recorded checks.
