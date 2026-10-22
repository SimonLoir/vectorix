# Template validation

- [x] Copy the requested branch into a new Git repository.
- [x] Keep web, API, administration, workers, and migrator.
- [x] Reduce models, contracts, permissions, and routers to foundation services.
- [x] Replace visual identity, configuration, examples, and documentation.
- [x] Generate an initial migration and deploy it to a fresh database.
- [x] Check types, lint, tests, and builds.
- [x] Verify startup and screens in a browser.

Validation performed on October 21, 2026:

- `pnpm check-types` and `pnpm lint`: passed, with non-blocking warnings.
- `pnpm test`: 10 Node tests and 11 license provider tests passed.
- `pnpm --filter api test:integration` against a separate PostgreSQL database: 6 scenarios and their suite passed. Coverage includes accounts, organizations, isolation, superadmin, API keys, licenses, notifications, and suspension.
- `pnpm build`: all four applications built successfully.
- Initial migration applied; a second deployment had no pending migrations; no difference between the schema and database.
- API `/health`, `/ready`, and OpenAPI schema verified with local PostgreSQL and Redis.
- Sign-in, dashboard, account, team, roles, API keys, licenses, and administration verified in production mode in the browser.

Notification tests cover persistence, deduplication, preferences, isolation, and failure recovery. No real email or push notification was sent. Docker images are provided; they were not built in this local environment because Docker is unavailable.

## Production images

- Dedicated Dockerfiles restored for web, admin, API, workers, and migrator.
- Next.js standalone output with an explicit tracing root for the monorepo.
- Backend dependencies isolated from the lockfile through pnpm 11, excluding development and optional dependencies.
- Removed the former generic Dockerfile, build-time environment defaults, and suppression of Prisma generation failures.
- Updated build instructions; all five images can be tested with `pnpm test:docker`, also automated in GitHub Actions.

Local checks after restoration: valid Prisma schema, 34 successful type/lint tasks, 21 passing unit tests, and four successful builds. Standalone outputs and pnpm deployments were also copied outside the repository and started: API ready with PostgreSQL/Redis, workers ready, 19 web assets and 13 admin assets served without errors. API/worker production stores contain no Next.js, TypeScript, Vite/Vitest, ESLint, or Prisma CLI.

## Image publication

- Configured registry: `pxdv.be/vectorix`, with one repository per service.
- On `main`, publish the five tested images with `sha-<full Git SHA>` tags, followed by `latest`. Builds are serialized to prevent an older build from overwriting the `latest` tag of a newer build.
- Authentication uses the GitHub Actions secrets `PXDV_REGISTRY_USERNAME` and `PXDV_REGISTRY_PASSWORD`. Adding them is deferred; while they are missing, tests run and publication is skipped with an explicit warning.
- Pull requests do not authenticate to the registry or publish images. Temporary images retained for publication are removed at the end of the job.

Local validation: workflow checked with actionlint; Bash syntax verified; missing/partial secret, publication failure, and old-commit rerun scenarios checked with a simulated Docker client. Image cleanup verified on success and failure. Valid Prisma schema, 38 successful type/lint/build tasks, and 21 passing unit tests. No actual image push was performed without registry credentials.

## RAG planning and documentation

- Recorded the agreed V1 scope, architecture, initial limits, implementation work packages, and acceptance criteria in [the RAG implementation plan](rag-implementation-plan.md). These features remain planned, not implemented.
- Standardized repository documentation and Mermaid labels in English, and recorded this convention in `AGENTS.md`.
- Documentation validation: Prettier formatting, local Markdown links, whitespace checks, and syntax parsing of all four Mermaid diagrams passed.

## Repository conventions

- [x] Expand `AGENTS.md` with applicable conventions for focused files, organization isolation, credentials, Prisma, versioned API contracts, frontend configuration, workers, and Docker. Verify paths and names against the current repository.
- [x] Keep `README.md`, package READMEs, the validation log, and the RAG plan in English; link the repository guide from the root README.
- [x] Validate documentation formatting, local links, whitespace, and all four Mermaid diagrams before committing. This change affects documentation only.

## RAG phase 1 — infrastructure

- [x] Add `infra/postgres-vector/Dockerfile` with pinned PostgreSQL/extension versions and checksum verification; bootstrap a dedicated schema and separate provisioning/runtime roles.
- [x] Extend `docker-compose.yml` and `.env.example` with independent vector storage and RustFS S3 storage, persistent volumes, health checks, and an idempotent private bucket initializer.
- [x] Add `scripts/test-infrastructure.sh` and `tests/infrastructure/` for actual migrations, vector indexes, role restrictions, private object operations, restarts, and isolated cleanup.
- [x] Extend `scripts/test-docker.sh` and `.github/workflows/docker.yml` to test and publish the vector image together with the five application images.
- [x] Document setup, data boundaries, and configuration in `README.md` and `docs/rag-infrastructure.md`; require branches and PRs in `AGENTS.md`.
- [x] Validate the Prisma schema, 17 type-check tasks, 17 lint tasks, 21 backend tests, and four application builds. Lint retains existing non-blocking warnings.
- [x] Build the vector image locally; verify the unsupported-CPU guard. Verify private RustFS upload, binary download, deletion, repeated initialization, and persistence after restart using isolated Docker resources.
- [x] Check workflow and shell syntax, documentation formatting, local links, whitespace, and all five Mermaid diagrams.
- [x] Automate the complete six-image Docker acceptance suite on GitHub Actions. The authoritative result for each revision is recorded in the [PR checks](https://github.com/SimonLoir/vectorix/pull/1/checks). The local VM has neither AVX2 nor FMA, so it cannot execute pgvectorscale; this is an explicit upstream requirement, including source builds.

The initial CI run built and started all applications and both vector extensions, then exposed an unstable HNSW fixture with almost collinear vectors and an isolated target. A local pgvector-only diagnostic reproduced the miss. The revised spatially distributed fixture with explicit search limits passed 20 local HNSW rebuilds; the complete HNSW/DiskANN and role checks remain enforced by CI. These are infrastructure smoke checks, not production recall benchmarks.

## RAG original phase 2 — catalog and access backend

The backend checklist below is complete. M1 subsequently completes the [catalog dashboard checklist](rag-catalog-access.md#dashboard-completion); its implementation and validation are recorded below.

- [x] Verify merged phase 1 and the updated VM with the isolated infrastructure suite: HNSW/DiskANN, role boundaries, catalog migrations, private S3 operations, and restart persistence passed locally.
- [x] Add organization-scoped catalog models for credentials, storage locations, documents, collection configuration revisions, vector connections, groups, grants, key scopes, quotas, and audit. The user approved schema generation; the additive migration was tested against fresh and upgraded isolated databases.
- [x] Add versioned credential, group, collection, access, quota, and audit contracts and handlers, with bounded lists and explicit permissions.
- [x] Resolve complete organization credentials before environment defaults, encrypt secrets, retain destination references, and reject invalid configured credentials without fallback.
- [x] Intersect collection API-key scopes with the issuer's current membership and rights; test revocation, suspension, direct identifiers, and cross-organization access.
- [x] Enforce catalog quotas transactionally and record sensitive mutations without secrets.
- [x] Add real PostgreSQL integration coverage, verify API metadata/contract parity, run schema/type/lint/test/build/container checks, and document the phase in English with Mermaid.
- [x] Commit and push the implementation on `codex/rag-catalog-access` for review against `main`.

Implementation entry points: `packages/db/prisma/models/rag.prisma` and `20261022000000_rag_catalog_access/migration.sql` define the stable catalog. `packages/api-contracts/src/v1/rag/` defines V1 revision 1; `packages/routers/rag/src/index.ts` composes the corresponding handlers. Shared credential resolution, access filters, transactions, and audit live in `packages/routers/rag/src/services/`. Organization key handlers bind scopes and issuers; the superadmin quota handler owns overrides. `scripts/test-catalog.sh`, `tests/catalog/`, `apps/api/src/rag-tests/`, and `.github/workflows/catalog.yml` exercise migrations and authorization.

The migration test verifies preservation of existing users, organizations, memberships, settings, and keys; no old key receives RAG privileges. Retention constraints are deferred until commit so organization cascades complete while referenced destinations remain protected. The integration suite covers empty-permission filtering as well as positive grants. Credential tests validate encryption and resolution using fixture values, without contacting embedding providers. No frontend journey or upload/search implementation is added in this phase.

Final local validation: frozen-lockfile installation and Prisma validation passed; all 18 type-check and 18 lint tasks passed (existing non-blocking warnings remain), as did 22 backend tests, 20 integration tests, and four application builds. The final six-image Docker suite passed startup/assets, pruned runtime dependencies, migration replay, worker execution, HNSW/DiskANN, database role boundaries, private S3 operations, and persistence after restart on the upgraded VM. Upstream pgvector/pgvectorscale emitted a non-failing TupleDesc warning; the PostgreSQL adapter emitted a non-failing pg query-concurrency deprecation warning. All test containers were removed. Six Mermaid diagrams, 14 local documentation links, changed-file Prettier formatting, shell syntax, and whitespace checks passed. No application database was migrated and no host application server was started.

## RAG delivery plan revision — dashboard journeys

- [x] Replace the backend-first work packages with complete dashboard-testable milestones in `docs/rag-implementation-plan.md`, including acceptance scenarios and a delivery-flow Mermaid diagram.
- [x] Make the missing catalog dashboard the immediate next milestone; record concrete web/admin integration entry points and distinguish saved configuration from live indexing/search capabilities.
- [x] Preserve the agreed V1 formats, providers, chunking strategies, parent context, permissions, and reindexing scope; stage each additional capability through a complete interface-to-processing-to-result journey.
- [x] Add the delivery and browser acceptance conventions to `AGENTS.md`; align status in `README.md`, `docs/rag-catalog-access.md`, `docs/rag-infrastructure.md`, and `packages/routers/rag/README.md`.
- [x] Validate changed-file Prettier formatting, 19 local Markdown links and their referenced anchors, concrete integration entry points, all eight Mermaid diagrams in the touched documents, and `git diff --check`.
- [ ] Implement and verify the M1 catalog dashboard. This plan revision does not add screens or change runtime behavior.

Touched files are the six documents named above and this build log. The plan maps dashboard actions through `apps/web/contexts/orpc.tsx`, versioned contracts, catalog handlers, transactional persistence/audit, and query refresh; it also identifies the admin quota entry point and future worker status flow. Application tests, builds, and browser checks are not required for this prose-only revision and have not been rerun.

## M1 — Catalog dashboard

- [x] Add collection/profile/history, credential, group/member/grant, usage, and audit screens with permission gates and server-filtered pagination.
- [x] Extend API-key dialogs with explicit collection scopes and the admin organization workspace with effective quota editing.
- [x] Add bounded principal/history and superadmin quota reads to API revision 1.2.0; keep metadata administration independent of content reading. No schema or migration change.
- [x] Validate types, lint, backend/integration tests, and application builds.
- [x] Verify the dashboard recipe with two organizations and distinct member permissions in a disposable environment.
- [x] Document actual browser results in `docs/rag-dashboard.md` and prepare the dedicated `codex/rag-catalog-dashboard` review branch.

Implementation entry points: `apps/web/components/rag/` contains focused catalog views and forms mounted under `apps/web/app/dashboard/collections/` and `settings/`. Existing API-key components now configure scopes. `apps/admin/src/components/organization-rag-quota.tsx` manages platform quota overrides. Versioned contracts call `packages/routers/rag/` and `packages/routers/superadmin/`, sharing catalog access checks, safe DTOs, and quota resolution. `apps/api/src/rag-tests/dashboard.ts` covers the additional read paths. Validation: 18 type-check tasks and 18 lint tasks passed (existing warnings remain), 22 backend tests passed, all four applications built, and `pnpm test:catalog` passed 24 core/RAG HTTP tests plus fresh/upgrade/repeat migration and schema-parity checks. Browser acceptance used production builds, isolated PostgreSQL/Redis, two fixture organizations and an owner/reader pair: configuration persistence, masked credentials and protected deletion, revision history, groups/grants/revocation, scoped key creation, cross-organization/direct-URL denial, audit, and admin quota enforcement passed. Browser review also found missing RAG permission labels, now added in all three existing locales. No application database or schema was changed; uploads and search remain planned. The six-image Docker suite was not rerun for this change; CI retains it. No live embedding or S3 provider check is claimed.

Final browser corrections were rechecked with web types, lint, and a standalone production rebuild: translated permission labels render correctly, the key dialog stays within the viewport with internal scrolling and closes with Escape, and the shared retry control cannot submit its surrounding form. The catalog suite was repeated after adding document-manager metadata coverage and again passed all 24 tests. Eight Mermaid diagrams, local file links in seven documents, formatting, and `git diff --check` passed.

## M1 follow-up — Localized catalog UI

- [x] Replace hardcoded catalog text with English, French, and Belgian Dutch `next-intl` messages, including dialogs, page headings, scoped-key controls, confirmations, plural counts, and number formatting.
- [x] Translate web dashboard navigation and home cards; keep page headings reactive to language changes.
- [x] Add an admin locale provider, a language selector, translated navigation/workspace tabs, and localized quota controls. Share cookie/header locale resolution through `packages/dashboard-core/src/i18n/locale.ts`.
- [x] Add an optional localized close label to the shared dialog primitive and use it in the catalog and key dialogs.
- [x] Run final types, lint, backend tests, builds, translation/ICU validation, and browser checks in all three locales.
- [x] Prepare the localization correction for the existing PR #3.

The changed UI uses `apps/web/messages/{en,fr,nl-BE}.json` and `apps/admin/src/messages/{en,fr,nl-BE}.json`. `CatalogPage` accepts message keys so client-side language switches update page headings as well as forms. The admin root reads the shared locale cookie and browser preference on the server; its language selector persists the cookie and refreshes the server tree. No schema or API contract change is required. Existing admin screens outside the catalog workflow and API-supplied diagnostic messages retain their previous language behavior.

Validation: frozen-lockfile installation, 18 type-check tasks, 18 lint tasks (existing warnings), 22 backend tests, and all four application builds passed. Message parity and ICU formatting passed for 211 web and 38 admin keys in each locale; seven locale-resolution cases passed. Browser checks against production standalone web/admin builds and disposable PostgreSQL/Redis covered reactive headings/navigation, collection profile forms and persistence, localized numbers/dates/ordinals, group zero/one-member plurals, credential and key-scope dialogs, quota editing, and language persistence after reload. Both browser consoles had no warnings or errors. Backend catalog integration and six-image Docker tests were not repeated for this translation-only follow-up; their prior results remain recorded above.

## M1 follow-up — OpenAI and Mistral provider catalog

- [x] Review and generate the additive provider enum and credential-table migration after explicit approval.
- [x] Extend V1 contracts to revision 1.3.0, encrypted credential persistence/update/DTO mapping, and existing organization-first resolution.
- [x] Expose both providers in dashboard integration and collection selectors, with provider endpoint examples and unchanged translated field labels.
- [x] Document environment configuration, migration deployment, native-adapter milestones, and the distinction between saved profiles and executed embeddings.
- [x] Validate schema, types, lint, tests, builds, upgrade preservation, contracts, and browser journeys.
- [x] Prepare the validated update for the existing PR.

Entry points: `packages/db/prisma/models/rag.prisma` and `20261023000000_openai_mistral_credentials/migration.sql`; `packages/api-contracts/src/v1/rag/{common,credentials}.ts`; credential services in `packages/routers/rag/src/services/`; dashboard selectors in `apps/web/components/rag/credentials/credential-form.tsx` and `collections/profile-fields.tsx`. `apps/api/src/rag-tests/embedding-providers.ts` covers provider persistence and retained bindings; `tests/catalog/provider-upgrade-{seed,check}.sql` extends the disposable migration workflow to preserve existing credentials and selection. No live provider request is made by this milestone.

Validation: Prisma generation and validation, 18 type-check tasks, 18 lint tasks (existing warnings only), 22 backend tests, and all four builds passed. `pnpm test:catalog` passed 26 core/RAG HTTP tests, fresh/repeat deployment, schema parity, and preservation of pre-catalog data plus existing encrypted credential records and selections during upgrade. The first run exposed a stale local generated client; regeneration resolved it and the full suite passed. Browser acceptance on standalone web/API builds with a disposable database created and reloaded both integrations, preserved a blank OpenAI edit secret, and saved `text-embedding-3-small`/1,536 and `mistral-embed`/1,024 profiles with organization credential bindings. These are synthetic credential/configuration checks, not live model validation. The browser console had no warnings/errors. Seven Mermaid diagrams, local documentation links, shell syntax, formatting, and whitespace checks passed. The six-image Docker suite was not rerun; PR CI retains it.

## M2a.1 — TXT/Markdown upload and inspection

- [x] Squash-merge PR #3 after both GitHub checks succeeded; start `codex/rag-document-library` from merged main.
- [x] Prepare the additive durable-ingestion schema and review explanation in `docs/rag-document-library.md`.
- [x] Generate the explicitly approved additive migration and verify fresh/upgrade/repeat deployments plus schema parity on disposable databases.
- [x] Implement authenticated private S3 upload, reservations, durable extraction/retries, authorized preview/download, and collection associations.
- [x] Deliver localized library list/details/forms and verify real upload, extraction, two collection links, original checksum and reader visibility.
- [x] Verify direct-URL denial after reader grant removal and invalid UTF-8 failure/retry after timezone/polling corrections.
- [x] Validate schema, types, lint, backend/storage integration tests, builds, containers and documentation.
- [x] Prepare the validated `codex/rag-document-library` branch for PR delivery.

Entry points: `packages/storage/` owns bounded private S3 I/O; `packages/routers/rag/src/services/documents/` owns storage bindings, upload reservations, authorized reads/links and the durable processor exported by `@routers/rag/ingestion`. `apps/workers/src/index.ts` schedules the identifier-only scan through `packages/queues/`. New V1 document contracts and handlers are under `packages/api-contracts/src/v1/rag/documents.ts` and `packages/routers/rag/src/documents/`; API revision is 1.4.0. `apps/web/app/dashboard/documents/` mounts focused localized views under `components/rag/documents/`. The approved migration is `20261024000000_document_ingestion`; tests preserve existing document and extraction records during upgrades.

Local validation: 19 type-check tasks and 19 lint tasks passed (warnings remain); 22 existing backend regressions passed; all four applications built. The expanded isolated catalog/storage suite passes 35 core/RAG tests. The six-image Docker suite passed production runtime checks and PostgreSQL/vector/Redis/private S3 infrastructure checks. Browser acceptance uses production builds and separate disposable PostgreSQL/Redis/RustFS: FR/EN Markdown upload, reload to ready, inert HTML preview, two collection associations, original download with identical SHA-256, reader visibility without management controls, and EN/FR/nl-BE switching/persistence passed. Browser review found missing timezone propagation in the client locale provider and query retries hiding access errors; both were corrected, the standalone web build passed again, and direct-URL denial plus failed-extraction retry now display explicit localized states. A fresh browser tab had no warnings/errors after switching language and reloading the corrected build. Seven Mermaid diagrams, 24 local documentation links, 43 document messages in all three locales, shell syntax and whitespace checks passed. Temporary browser tabs, web/API/workers and their three disposable infrastructure containers were stopped after verification. No application database was used. No live embedding check is claimed. M2a.2 retains replacement and deletion/retention controls; this slice must not be described as completing all of M2a.

## M2a.2 — Replace and delete documents

- [x] Verify green PR #4, squash-merge it after explicit authorization, and start `codex/rag-document-lifecycle` from merged main.
- [x] Prepare and review the additive filename/cleanup schema; generate approved migration `20261025000000_document_lifecycle`.
- [x] Add expected-version/idempotent replacement, retained publication, tombstones, version metadata, durable object cleanup, reservation release and cleanup retry.
- [x] Add localized replacement/deletion dialogs, retention controls, version history and manager deleted view to the existing dashboard journey.
- [x] Document retention deadlines, saved storage bindings, immediate denial, no restore action and intentionally retained metadata/credential references.
- [x] Validate schema, types, lint, backend/integration tests and production application builds.
- [x] Verify the production dashboard replacement/failure/deletion/cleanup-retry journey and English/French/Belgian Dutch locale controls.
- [x] Verify all six local Docker images/infrastructure, parse Mermaid/local links/messages, and check documentation formatting/whitespace.
- [x] Remove temporary browser tabs, web/API/workers, the S3 test forwarder and all three preview containers; verify their host ports are unbound.
- [x] Prepare the tested `codex/rag-document-lifecycle` branch for PR delivery.

Entry points: `packages/db/prisma/models/rag.prisma` and `20261025000000_document_lifecycle/migration.sql` add the approved persistence. V1 revision 1.5.0 contracts live in `packages/api-contracts/src/v1/rag/documents.ts`; handlers compose shared `services/documents/{replace,delete,lifecycle,retention,cleanup,transfer,ingestion-state}.ts`. `@routers/rag/cleanup` supplies the worker scan invoked by `apps/workers/src/index.ts`. Focused lifecycle, replacement, deletion, retention and version-list components live in `apps/web/components/rag/documents/`. `apps/api/src/rag-tests/document-lifecycle.ts` covers the HTTP/storage journeys. [Document lifecycle](rag-document-lifecycle.md) records the data flow, safety windows, retained audit policy, prerequisites and dashboard recipe.

Validation: approved migration generation and Prisma validation passed; disposable fresh/upgrade/repeat deployments and schema parity preserved historical documents and an active ingestion task. All 19 type-check and 19 lint tasks passed (warnings remain), 22 backend regressions and 42 core/RAG integration tests passed, and all four applications built. Seven new lifecycle scenarios cover retained publication, failed extraction/retry, concurrent replacements, organization/scoped-key access, deletion, storage failure/retry, expired cleanup leases and a delayed PUT after completed cleanup. That late-write check verifies renewed cleanup/reservation charging followed by confirmed object deletion and quota release. All six local Docker images/infrastructure passed.

Browser acceptance used production web/API/workers with disposable PostgreSQL/Redis/RustFS. A manager uploaded FR/EN Markdown and attached one collection; with workers paused, replacement retained reader access to version 1 without management actions. Resuming workers published version 2; its downloaded SHA-256 matched the replacement file. Invalid UTF-8 version 3 and extraction retry retained version 2. EN/FR/nl-BE switching and Belgian Dutch reload persistence passed. Zero-day deletion retained manager metadata and immediately denied the reader's live/deleted-metadata URLs. An actual RustFS outage showed failed cleanup; fixture attempt counters were advanced to four to shorten backoff, and a temporary loopback forwarder restored the saved endpoint after Docker assigned a different random restart port. Dashboard retry and real workers completed cleanup for all three versions. After also deleting the cache-guard fixture, all four version cleanup records were COMPLETE; real S3 listing returned no organization objects, database retained original/extraction/reservation usage was zero, and the dashboard showed zero documents and 0 MiB of recorded storage. These browser results cover one collection and locale switching, not every action/state in every locale.

A later UI-only deleted-page cache guard passed scoped web types/lint and a standalone production rebuild. A second disposable fixture verified that warm live data is replaced by loading then tombstone after deletion, without stale live controls. The final fresh tab had no console warnings/errors, including after warm-cache deletion. Nine Mermaid diagrams, 35 local links, 80 document messages in all three locales, formatting and whitespace checks passed. All temporary browser tabs, application processes, the S3 test forwarder and three preview containers were stopped; ports 3100/3101 and the former test S3 port were unbound. The tested branch is prepared for PR delivery. No application database was migrated; no live embedding call, PDF/DOCX extraction, indexing or search result is claimed.

### M2a.2 review correction — preserve accepted cleanup deadlines

- [x] Independently review PR #5 before merging; reproduce the race where a later request revoked an active cleanup token and promised a later retention deadline after S3 deletion had started.
- [x] Preserve existing replacement cleanup deadlines and in-flight cleanup tokens; allow deletion only to accelerate unstarted cleanup. Explain this retained-deadline policy in all three locale hints and lifecycle documentation.
- [x] Exercise three real RustFS DELETE/deadline regressions; 45 isolated integration tests, 19 type checks, 19 lint tasks, 22 backend regressions and all four application builds pass.
- [x] Merge the independently reviewed head after both updated GitHub checks pass.

The correction lives in `packages/routers/rag/src/services/documents/retention.ts`. PostgreSQL fencing cannot undo an external deletion, so later requests must not postpone an already accepted retirement schedule.

## M2b — PDF/DOCX upload and source inspection

- [x] Squash-merge the independently reviewed PR #5 after catalog and six-image checks passed; base `codex/rag-pdf-docx` on merged main.
- [x] Add a lightweight shared extraction artifact package, compatible V1 revision 1.6.0 source previews and parser diagnostics.
- [x] Add original-plus-10-MiB rich reservations to upload, replacement, retry and late-write reconciliation; retain legacy TXT/Markdown objects and confirmed cleanup semantics.
- [x] Add bounded native PDF and isolated DOCX parsing only in workers, immutable page/paragraph ranges and localized dashboard source navigation.
- [x] Complete real/adversarial parser, HTTP/S3, authorization, cleanup and quota verification; final production container checks are recorded below.
- [x] Run types, lint, backend regressions, builds, documentation/diagram checks and production dashboard acceptance.
- [x] Independently review and deliver PR #6; squash-merge after both catalog and six-image CI checks pass.

Entry points and the full acceptance recipe/results are in [PDF/DOCX library](rag-rich-documents.md). No database change is required. Validation passed: Prisma, 20 type-check and 20 lint tasks (non-blocking warnings), 22 backend regressions, all four application builds, 43 parser tests, independent verification of 37 deterministic binaries, and 64 real core/RAG integration tests plus migration fresh/upgrade/repeat/schema parity. Independent review corrected prototype-extension acceptance and orphaned DOCX story/note extraction; seven targeted reference regressions were independently rerun.

Production browser checks cover real bilingual PDF upload/page navigation/source jump/original checksum; DOCX headings/sections, current headers/footnotes and 28,818-character bounded pagination; scanned replacement failure retaining the prior source; mixed-PDF blank-page warning; collection reader visibility, revoked-grant and cross-organization direct-URL denial; EN/FR/nl-BE and locale persistence; dashboard deletion followed by completed cleanup, confirmed S3 object absence and zero version reservation. No embedding, vector indexing or retrieval is claimed by this extraction milestone.

Final container validation after the active-reference correction: all six images and infrastructure checks passed, including the real bundled native PDF and isolated DOCX parser, API dependency exclusion, standalone web/admin assets, worker startup, fresh/repeated migrations, HNSW/DiskANN roles and private S3 restart persistence. Ten Mermaid diagrams, 47 local links and 111 document messages in all three locales validate. No application database was used.

The final fresh manager tab had no console warnings/errors. Temporary tabs, web/API/workers, their disposable PostgreSQL/Redis/RustFS and the checksum-verified test download were cleaned up. The pre-existing admin route-type import modification is preserved outside this commit.

## M3 — First Ollama index and hybrid search

- [x] Merge independently reviewed M2b PR #6 after both CI checks succeed; start `codex/rag-first-search` from squash commit `e4c4685`.
- [x] Prepare/review additive generation, publication, chunk, task, ordered receipt, accounting and source-hold schema; generate explicitly authorized migration `20261026000000_rag_indexing`.
- [x] Verify initial disposable upgrade/fresh/repeat migration deployment and Prisma schema parity.
- [x] Implement bounded structure chunking, native Ollama probe/embedding, independent vector adapter and durable first-index/publication/update/cleanup processing.
- [x] Connect localized profile/model controls, index status/retry/chunks, collection document metadata, hybrid playground, exact sources and deleted-collection cleanup to V1 revision 1.7.0.
- [x] Complete independent protocol review and integrated regressions, including canonical metadata, old V1 clients and source cleanup races.
- [x] Pass schema, workspace types/lint, backend/package/integration tests, all application builds and six container images.
- [x] Verify representative dashboard journeys with a real installed Ollama model; record exact provider/model/dimensions, source/checksum, access, replacement, cleanup and locale results.
- [x] Review documentation, Mermaid, links and whitespace; commit/push and deliver independently reviewed PR #7. Both catalog and six-image CI checks passed; squash-merged as `7143a44`.

Entry points, architecture and detailed acceptance results are in [first collection search](rag-first-search.md). Native Ollama, structure chunking, the independent vector adapter, durable generation/publication/outbox/accounting/source-hold services and V1 revision 1.7.0 connect the profile, index, metadata, chunk, playground and exact-source dashboard journeys. Native organization deletion uses a preflight, transactional Prisma adapter and database guard. Admin core pages/forms now use complete English/French/Belgian Dutch messages and locale-aware dates/numbers. A locked, independently reviewed generator patch preserves native BigInt defaults; all five service Dockerfiles include it before frozen installation.

Validation passed: frozen install, Prisma generation/validation, 23 workspace type-check tasks, 23 lint tasks (non-blocking warnings), 23 backend regressions, seven chunking tests, 21 controlled HTTP embedding tests, 11 real vector-store tests, all 88 isolated catalog/core/RAG integration tests, fresh/upgrade/repeat migration and schema parity, four production application builds and six-image runtime/infrastructure checks. Independent critical review found no remaining P1/P2 blocker. All 3,345 locale messages have ICU/key parity, and changed documentation/Mermaid/local links validate.

Actual production-browser acceptance used real CPU Ollama 0.40.8 with original EmbeddingGemma, 256-dimensional DiskANN, private RustFS and isolated application/vector databases. The separate live adapter also verified 128/256/512/768 dimensions. PDF/DOCX/Markdown upload, structure/page/paragraph previews, initial publication, FR/EN hybrid/lexical/vector queries, combined filters, exact indexed sources and original checksums passed. Index-only pause proved library version 2 can publish while indexed version 1/source remain readable despite zero-day retention. Resume published version 2. A real DOCX quota failure left old charges unchanged; admin quota increase and dashboard retry published the two new passages. Reader access, grant revocation during source viewing and foreign direct-URL denial passed. EN/FR/nl-BE and admin zero temporary quota persistence passed.

Collection deletion denied its direct URL while retaining the three shared library documents. After controlled advancement of only already-retired hold/task deadlines in the disposable fixture, real workers tombstoned four publications, dropped the vector table, deleted nine application chunks, released four holds and reduced A/R/U counters to zero. Dashboard zero-day Markdown deletion then purged both versions; real S3 HEAD checks confirmed absent originals/extractions, while PDF/DOCX originals/artifacts remained. The deleted-collection view showed zero pending/failed tasks. A fresh final web tab had no console warnings/errors. Detailed distinctions between browser checks, simulated failure coverage and real integrations are retained in the milestone document; no paid-provider, reference-corpus quality or M7 capacity result is claimed. The named Ollama volume is retained for subsequent milestones; preview processes/containers are stopped after acceptance.

### Ollama and EmbeddingGemma reproducibility guide

- [x] Document the executed CPU Docker image/resource limits, original EmbeddingGemma model/digest, native probe and same live adapter script in [the reproduction guide](rag-ollama-embeddinggemma.md), with an English Mermaid data-flow diagram.
- [x] Explain organization-first credentials, exact endpoint approval on API/workers, host/container networking, saved bindings, dashboard steps and troubleshooting; link the guide from `README.md` and `packages/embeddings/README.md`.
- [x] Verify the recorded four-dimension real-model evidence against logs and distinguish it from 21 controlled HTTP tests, integrated dashboard acceptance and unperformed capacity/quality benchmarks. Check official primary references, Markdown formatting, local links, Mermaid, shell syntax and Compose YAML.

## M4 — Rebuild while searching

- [x] Deliver M3 through PR #7 with real dashboard/provider evidence and the requested Ollama reproduction guide; both GitHub checks passed and PR #7 was squash-merged as `7143a44`.
- [x] Prepare and independently review the nullable same-collection predecessor reference and candidate-admission constraints in [the rebuild design](rag-index-rebuild.md).
- [x] Generate and validate `20261027000000_rag_rebuild` on disposable databases: historical active-generation preservation, fresh install, upgrade, repeat deployment and Prisma schema parity passed.
- [x] Implement compatible V1 contracts, draft profiles, double-grant rebuild/discard admission, per-generation metadata, atomic activation and bounded old-generation retention/cleanup.
- [x] Deliver localized active/draft comparison, progress/recovery, generation-aware chunk preview and active-profile search controls.
- [x] Complete isolated backend, real dashboard/Ollama and container checks; record actual results.
- [x] Finish documentation checks and remove temporary preview resources.
- [x] Deliver PR #24 after independent review and both GitHub checks passed; squash-merged as `06f3366` on October 22, 2026.

Entry points: approved `20261027000000_rag_rebuild` and `packages/db/prisma/models/rag-indexing.prisma`; compatible V1 revision 1.8.0 contracts/handlers for rebuild and discard; `services/indexing/{generation-acceptance,activation,changes,discard,profile-metadata,source-holds,cleanup-index}.ts`; dashboard comparison/generations/chunks/search in `apps/web/components/rag/indexing/`; isolated scenarios in `apps/api/src/rag-tests/index-rebuild{,-locks}.ts`. [Rebuild behavior and acceptance](rag-index-rebuild.md) records the concrete data flow, prerequisites, recipe and limitations.

Validation passed: Prisma generation/validation, seven-migration fresh/upgrade/repeat/schema-parity checks, 23 workspace type-check tasks, 23 lint tasks with non-blocking warnings, 23 backend regressions, four production application builds, all 95 isolated integration tests and the final six-image Docker suite. Independent critical review found no remaining P1/P2 issue. Lock-contention tests verify the organization admission write does not deadlock collection cleanup or reactivate suspended organizations. Additional tests cover compound current grants/scopes, accepted controller versus later library actor, idempotent replay, retries, partial-candidate cleanup without an artificial receipt delay and captured-A hydration/source access across activation.

Actual browser acceptance used built web/admin/API/workers, real CPU Ollama 0.40.8/original EmbeddingGemma and four disposable infrastructure containers. A 256-dimensional generation served two documents/four passages while a 128-dimensional candidate partly published and failed its quota. A remained searchable; dashboard discard naturally removed the failed table and charges. With suitable quotas, another rebuild caught up a Markdown replacement, newly attached DOCX and metadata edits made while only indexing was paused. It activated at content sequence five with three documents/six passages. Reopening and downloading a previously captured A source after activation preserved version 1 with matching SHA-256; new searches returned version 2 and the newly declared department filter selected the DOCX. The playground retained the prior-result label and generation-specific filters; chunk preview showed the active six passages.

After the old-source proof, only the isolated fixture's retired generation/hold/index-cleanup deadlines were advanced. Real workers dropped/tombstoned A, retained C's six rows and reduced A/R/U from 6/8/0 to 6/0/0. A second narrowly scoped advancement changed only the unused old version's pending document-cleanup availability after all holds were released. Workers then purged its original/extraction; S3 HEAD checks confirmed all three current original/extraction pairs remained. No completion state, accounting or physical data was fabricated. EN/FR/nl-BE comparison/state/date/number controls and Belgian Dutch reload persistence passed; a fresh final web console had no warnings/errors. Admin quota changes passed; its preexisting organization-list timezone fallback is recorded for M7 below. No paid-provider, reference-corpus quality or final capacity result is claimed.

### M7 follow-up observations

- [x] Propagate server-resolved `VECTORIX_TIME_ZONE` through admin locale setup/provider, matching web. The dashboard timezone follow-up below verifies the runtime handoff and removes `ENVIRONMENT_FALLBACK` without suppressing errors.
- [ ] Exercise automatic active-index source updates when the library actor lacks that collection's management grant. M4 explicitly uses the accepted rebuild authority for pending candidates; the active-generation event-actor path still needs this operational coverage and any required current-authority handling.

Final documentation checks passed: 16 documents, 18 parsed Mermaid diagrams, 92 local links and 3,453 ICU messages with locale/key parity. Temporary browser tabs, four application processes and four owned infrastructure containers were removed, and Ollama stopped while its named model volume was preserved. The historical-source download was checksum-verified and removed.

### M4 CI PostgreSQL readiness correction

- [x] Diagnose PR #24's Docker smoke failure: the Unix-socket probe accepted PostgreSQL's temporary initialization server before `vectorix_test` existed, and the next probe raced its intentional shutdown.
- [x] Make application/vector readiness probes in `scripts/test-docker.sh` and `scripts/test-catalog.sh` use explicit loopback TCP. The entrypoint's temporary socket-only server cannot satisfy that check. Existing Compose health checks already use TCP and need no change.
- [x] Verify shell syntax and whitespace, independently review the targeted diff, and rerun both suites from the isolated M4 checkout: all six production images/infrastructure checks and all 95 disposable catalog/core/RAG tests passed, including fresh/upgrade/repeat migrations and schema parity. No production application behavior changes.

## M5a — Cohere provider

- [x] Add native bounded Cohere discovery, capability probing, document/query embedding and explicit hosted capability identity while preserving legacy Ollama manifests.
- [x] Unlock compatible contracts, provider-bound endpoints, identity checks and profile/status gates together.
- [x] Deliver coherent localized provider/model/dimension/preset controls and honest discovery/fingerprint labels in the existing dashboard.
- [x] Validate controlled native-wire provider/API journeys, production dashboard flow, checks/builds/containers and independent review; record live-provider limitations.
- [x] Verify the final fresh browser console and remove owned preview resources.
- [x] Complete final documentation accuracy, formatting, local-link, Mermaid and locale checks.
- [x] Deliver [PR #28](https://github.com/SimonLoir/vectorix/pull/28) after both catalog and Docker image CI checks passed; squash-merged as `9715138`.

Design and configuration: [Native Cohere embeddings](rag-cohere-embeddings.md). No Prisma schema or migration change is required; generation snapshots already store versioned JSON and credentials already support Cohere. New public identity metadata is optional in compatible V1 revision 1.9.0. Paid-provider credentials will be added by the user to an organization later; do not present controlled HTTP results as live Cohere acceptance.

Entry points: native protocol/identity/dispatch in `packages/embeddings/src/{cohere,dispatch,http,types}.ts`; compatible optional metadata/revision fencing in `packages/api-contracts/src/v1/rag/{indexing,indexing-types}.ts`; provider-bound endpoint/profile/identity checks in `packages/routers/rag/src/services/indexing/{embedding-profile,models,index-document,search,views}.ts`. Controlled native-wire journeys live in `apps/api/src/rag-tests/cohere-{fixtures,indexing}.ts`; focused UI is `apps/web/components/rag/collections/{embedding-fields,model-discovery}.tsx` and `indexing/model-verification.tsx` with three dictionaries. `AGENTS.md` records the protocol/snapshot boundary; README/environment example and provider/package guides explain configuration.

Validation: 49 native controlled HTTP tests (21 unchanged Ollama, 28 Cohere), 101 disposable core/RAG API tests, 23 workspace type checks, 23 lint tasks, 23 backend regressions, four production builds and six actual images/runtime/infrastructure checks passed. No migration added; seven-migration fresh/upgrade/replay/schema parity still passes. Independent review identified optional hosted catalog metadata as an availability issue; bounded nullish parsing and two regressions resolved it without bypassing the supported catalog or native role probes. The final API/workers bundles and Docker pass include this correction. No P1/P2 remains.

Actual dashboard acceptance uses a deterministic controlled Cohere HTTP fixture, real CPU Ollama 0.40.8/original EmbeddingGemma and private disposable infrastructure. The manager configured synthetic organization credentials and uploaded bilingual Markdown. A real Ollama 256-dimensional index served two passages while the saved Cohere512 draft remained separate. Unsaved changes made zero provider calls; saved discovery/model/dimension controls and truthful hosted fingerprint labels passed. With indexing alone paused, accepted rebuild and old Ollama search/source worked. Resume activated Cohere512; the old captured source still downloaded with matching SHA-256, and new FR hybrid/EN vector retrieval returned the Cohere generation. Keyword-only search left all provider counters unchanged. A newly selected invalid organization credential failed explicitly for a new collection, while the existing generation retained its original valid binding; platform-fallback calls remained zero. EN/FR/nl-BE labels/number formatting and reactive error translation passed. The retained old generation remained on its ordinary grace; no M5 clock advancement or final physical cleanup soak is claimed. Live paid-provider availability/quality remains pending credentials, independently of this controlled product-path validation.

The final fresh Belgian Dutch browser tab had no console warnings/errors and preserved its locale. All four product previews, the controlled Cohere server, four owned infrastructure containers and their temporary tabs were stopped/removed; ports 3100/3101/3006 and the controlled provider port are unbound. The downloaded synthetic original was checksum-verified before removal. The retained named Ollama model volume remains available for later milestones.

Final M5a documentation validation passed: 17 documents, 20 parsed Mermaid diagrams, 111 local Markdown links and all 3,495 web/admin ICU messages with English/French/Belgian Dutch key parity. Formatting and whitespace checks passed. The acceptance record distinguishes controlled Cohere from real Ollama/infrastructure and leaves paid-provider availability, retrieval quality and retention-soak claims pending. PR #28 passed both CI checks and was squash-merged as `9715138`.

## M5b — Voyage provider

- [x] Review current primary provider documentation, fixed model capabilities and native wire semantics; no documented model-list endpoint exists.
- [x] Add a bounded native Voyage adapter and schema-version-3 capability identity, preserving saved Ollama/Cohere snapshots.
- [x] Wire compatible optional local-catalog metadata and V1 revision 1.10.0 through saved-revision API checks, indexing, rebuild and search.
- [x] Deliver coherent, localized Voyage profile controls and explicitly unverified local model listing.
- [x] Run meaningful controlled protocol/integration tests, workspace checks, production builds and all six images; independently review the final change.
- [x] Execute the dashboard acceptance recipe with controlled native Voyage, record exact sources, credential failures, rebuild and language results, and clean owned resources.
- [x] Validate final documentation, diagrams, local links and locale parity after dashboard acceptance is recorded.
- [x] Deliver a dedicated reviewed PR from merged M5a.

Implementation and controlled dashboard acceptance are complete on `codex/rag-voyage-provider`, based on merged M5a PR #28 (`9715138`). Design, concrete acceptance recipe and actual results are in [Native Voyage embeddings](rag-voyage-embeddings.md). No Prisma schema change or new migration is required. Live-provider verification remains pending organization credentials supplied by the user later; listing a reviewed local model catalog is not credential verification.

Automated validation passed: 69 controlled native embedding HTTP tests, 107 disposable core/RAG catalog tests, 23 workspace type checks, 23 lint tasks, 23 backend regressions, four production builds and all six image/runtime/infrastructure checks. Independent review found no remaining P1/P2 issue. These results do not establish live paid-provider connectivity or retrieval quality.

Actual dashboard acceptance used production web/API/workers, four disposable infrastructure services and a deterministic native Voyage HTTP fixture; this run made no Ollama or hosted-provider calls. Local listing showed three reviewed models with explicitly unverified access and all provider counters unchanged at zero. Native document/query verification succeeded at 256 dimensions. A bilingual 562-byte Markdown original produced three chunks. With indexing alone paused, a saved 512-dimensional draft and accepted rebuild left A256 searchable; resume activated B512. A captured old French hybrid source reopened and downloaded with matching SHA-256 after the switch. New English vector and French hybrid retrieval used B; the hybrid result exposed both ranks. Keyword-only retrieval returned two passages with every fixture counter unchanged at 11 organization and zero platform requests.

A newly selected invalid synthetic credential bound a new collection, whose local catalog still showed three unverified models. Actual verification failed with sanitized `PROVIDER_REJECTED`, without creating a generation, despite a configured valid platform fallback. The existing B profile retained its original valid binding and verified at 512 dimensions after that selection. The provider/API had exited successfully before the final counter fetch, so no additional post-invalid-key zero-platform-counter proof was collected; explicit failure behavior and integration tests cover the fallback contract. Reactive English/French/Belgian Dutch errors, date/number/profile labels and persisted Belgian Dutch passed. The final fresh tab had no console warnings or errors.

Owned previews/provider, four infrastructure containers, temporary tabs and the checksum-verified download were removed; ports 3100/3101/3006 and the controlled provider port were unbound. A's three chunks remained retained on the normal 17-minute grace at the last dashboard observation. No M5b clock advancement, physical-retirement soak or live paid-service quality/availability claim is made.

Final documentation validation passed: 18 documents, 21 parsed Mermaid diagrams, 128 local Markdown links and all 3,513 web/admin ICU messages with English/French/Belgian Dutch key parity. Prettier formatting and `git diff --check` passed. The record explicitly separates controlled Voyage from live paid-service verification and notes the uncollected final invalid-key counter snapshot. [PR #29](https://github.com/SimonLoir/vectorix/pull/29) passed both CI checks and was squash-merged as `bb32977`.

## M5c — OpenAI provider

- [x] Review current official OpenAI embedding/model documentation and compatible dimension-range representation through the OpenAI Docs skill.
- [x] Add the native adapter, reviewed shortening ranges, bounded catalog/probes/batches and strict schema-version-4 identity while preserving versions 1–3.
- [x] Wire optional range metadata, compatible V1 revision 1.11.0 and complete saved API bases through indexing/rebuild/search.
- [x] Deliver localized numeric range controls, truthful discovery/verification and inspectable unsupported saved values.
- [x] Run package/integration/workspace checks, production builds, six images and independent review on the final source.
- [x] Execute the dashboard recipe with controlled native OpenAI, record sources/rebuild/credentials/locales and clean owned resources.
- [x] Validate English documentation, Mermaid, links and ICU parity.
- [x] Deliver a dedicated reviewed PR from merged M5b.

Implementation, automated checks and controlled dashboard acceptance are complete on `codex/rag-openai-provider`; [native OpenAI design and acceptance](rag-openai-embeddings.md) describes the current scope. No Prisma schema or migration change is planned. The user will configure paid-provider keys in an organization later; controlled results must not be presented as live provider acceptance. Voyage [PR #29](https://github.com/SimonLoir/vectorix/pull/29) passed both CI checks and was squash-merged as `bb32977`; this branch now uses that merged tree.

Validation passed: 95 native controlled HTTP tests (26 OpenAI plus 69 existing), 114 disposable catalog/core/RAG tests with seven-migration fresh/upgrade/replay/schema parity, 23 workspace type checks, 23 lint tasks, 23 backend regressions, four production builds and all six images/runtime/infrastructure checks. The first catalog run failed on a fixture's invalid direct IndexTask.documentId filter; the corrected relational filter and complete rerun passed. Independent production and UI/contract review found no remaining P1/P2 issue. No migration added.

Actual dashboard acceptance used production web/API/workers, disposable PostgreSQL/vector/Redis/private RustFS and a deterministic native OpenAI fixture, without Ollama or paid-service calls. A saved small/257 profile discovered two reviewed native catalog models, verified exact dimensions and published three bilingual Markdown passages. Arbitrary 257 remained valid across explicit model changes. Pausing only indexing kept A searchable while a large/3072 DiskANN draft and rebuild were accepted; resume activated B. A captured old French source reopened after the switch and downloaded with the identical SHA-256 recorded in the provider guide. New English vector and Markdown-filtered French hybrid searches used B, with both ranks 1 for the French passage.

Keyword-only retrieval returned the French passage without changing any fixture counter. A new invalid organization key rejected native discovery and actual verification for another collection, while B retained its original valid binding and continued probing/searching. Durable final counters were 16 successful organization requests, 2 rejected invalid-key requests and 0 platform calls despite a valid fallback. English/French/Belgian Dutch reactive errors, range/profile/date/number formatting and persisted Belgian Dutch passed; a fresh final tab had no console warnings/errors. Owned previews/provider, four infrastructure containers, all three temporary tabs and the checksum-verified download were removed; preview/provider ports are unbound. A's three chunks remained on the ordinary 17-minute grace; no M5c retirement soak or live paid-provider claim is made.

Final documentation validation passed: 19 documents, 22 parsed Mermaid diagrams, 143 local Markdown links and all 3,534 web/admin ICU messages with English/French/Belgian Dutch key parity. Formatting and whitespace checks passed; current API revision references and earlier provider introductions now include OpenAI. [PR #30](https://github.com/SimonLoir/vectorix/pull/30) passed both required CI checks and was squash-merged as `124c991`.

## M5d — Mistral provider

- [x] Review official native model/embedding documentation, fixed dimensions, aliases and conservative processing/batch policy.
- [x] Add bounded native discovery, probes/batches, stable observed-response binding and schema-version-5 identity while preserving versions 1–4.
- [x] Wire complete saved API bases, compatible API revision 1.12.0 and optional observed-model metadata through indexing/rebuild/search.
- [x] Deliver localized fixed-dimension controls and truthful discovery/verification, preserving unsupported saved profiles.
- [x] Run package/integration/workspace checks, production builds, all six images and independent review on the final source.
- [x] Execute the controlled native dashboard acceptance recipe, record exact sources/rebuild/credentials/locales and clean owned resources.
- [x] Validate English documentation, Mermaid, links and ICU parity.
- [x] Deliver a dedicated reviewed PR from merged M5c.

Implementation, automated validation and controlled dashboard acceptance are complete on `codex/rag-mistral-provider`; [Mistral design and acceptance](rag-mistral-embeddings.md) records the scope. No Prisma schema or migration change is planned. OpenAI [PR #30](https://github.com/SimonLoir/vectorix/pull/30) passed both required CI checks and was squash-merged as `124c991`; this branch now uses that merged tree. The user will add paid-provider keys to an organization later; controlled results cannot establish live provider connectivity or quality.

Validation passed: 123 native controlled HTTP tests (28 Mistral plus 95 existing), 121 disposable core/RAG catalog tests with seven-migration fresh/upgrade/replay/schema parity, 23 workspace type checks, 23 lint tasks, 23 backend regressions, four production builds and all six image/runtime/infrastructure checks. The initial API type pass found an obsolete dimension-one fixture branch; the corrected fixture and final 23-task pass succeeded. Review against the official SDK identified optional/default cosmetic response metadata; four native regressions and a final complete catalog/build/image pass cover its bounded handling. Model/index/vector fields remain mandatory for association. Independent review and final parser-delta review found no remaining P1/P2 issue. No migration added.

Actual dashboard acceptance used production web/API/workers, disposable PostgreSQL/vector/Redis/private RustFS and a deterministic native Mistral fixture, without Ollama or paid-service calls. The saved base-alias/1024 profile discovered two reviewed names, showed the distinct observed dated response ID and published three bilingual Markdown passages. A paused alias/profile-change rebuild kept A searchable; resume activated B, while a captured old French source reopened and downloaded with an identical SHA-256. New English vector and Markdown-filtered French hybrid queries used B; the French passage had both ranks 1. This alias rebuild does not claim different underlying weights.

Keyword-only retrieval left every fixture counter unchanged. Deliberately changing the returned reviewed alias failed search explicitly with MODEL_CHANGED; restoration allowed success. A new invalid organization credential rejected native discovery and probes without fallback, while B retained its original valid binding and remained usable. Final durable counters were 17 authenticated organization requests (including the controlled model-drift failure), two invalid-key rejections and zero platform calls. English/French/Belgian Dutch reactive errors, observed-model/budget labels, number/date formatting and persisted locale passed; a fresh final tab had no console warnings/errors. Owned previews/provider, four containers, three temporary tabs and the checksum-verified download were removed; ports are unbound. A's three chunks remained on the ordinary 17-minute grace; no retirement soak or live paid-provider result is claimed.

Final documentation validation passed: 20 documents, 23 parsed Mermaid diagrams, 168 local Markdown links and all 3,555 web/admin ICU messages with English/French/Belgian Dutch key parity. Formatting and whitespace checks passed. [PR #31](https://github.com/SimonLoir/vectorix/pull/31) passed both required CI checks and was squash-merged as `78fa15d`.

## Security follow-up — API-key issuer revocation (issue #8)

- [x] Confirm the generic authorization gap and reuse the existing organization-scoped API-key principal model without a migration.
- [x] Resolve the current issuer and intersect current role permissions with the key's stored permissions for every generic organization operation.
- [x] Reject missing, mismatched or legacy principals without inferring ownership or granting historical privileges; preserve session-only and RAG scope checks.
- [x] Cover role/member revocation, re-addition, organization boundaries, malformed stored permissions, narrow scopes and invalid-key HTTP status in isolated API tests.
- [x] Run focused and workspace validation, actual dashboard revocation checks and independent review; distinguish the user-deferred browser restoration from completed automated coverage.
- [x] Finish documentation checks, including English Mermaid and local file links.
- [x] Deliver the separate reviewed PR.

Implementation and validation are complete on `codex/api-key-issuer-revocation`, following the user's request to inspect Claude's issues. Newly created supported scoped keys already have an `ApiKeyPrincipal`, so no schema expansion or automatic historical-key attribution is needed. Keys must never outlive the issuer's current permissions; legacy/unbound keys require reissue through the authenticated dashboard. Mistral [PR #31](https://github.com/SimonLoir/vectorix/pull/31) passed both required CI checks and was squash-merged as `78fa15d`; this branch now uses that merged tree. The confirmed global request-body limit (#10) and canonical password-reset origin (#17) issues also have implementation-ready designs; they are separate changes from this issuer fix.

Issue #8 implementation and final automated validation are complete. Touched files are `packages/routers/utils/src/api-key-access.ts`, `packages/routers/utils/src/authorized.ts`, `apps/api/src/api-key-issuer-revocation.ts`, `apps/api/src/integration.test.ts`, `docs/api-key-authorization.md`, this log, `README.md` and `AGENTS.md`. No schema, DTO or migration change is needed. Authorization now intersects the stored key scope with the exact bound issuer's current role union, validates current key/principal state, preserves sessionless key contexts and returns invalid-key HTTP 401 explicitly. Old unbound/legacy keys require supported reissue; removing/rejoining a user cannot revive a lost membership binding. Admission does not cancel already-admitted requests.

Final checks passed: 128 disposable core/RAG HTTP tests with fresh/upgrade/replay/schema parity, 23 workspace type checks, 23 lint tasks, 23 backend regressions, four production builds and all six production image/infrastructure checks. The first catalog run found an overlong synthetic reissue-key name; the shortened fixture and complete final run passed. A host restart interrupted the next catalog/image runs and erased temporary logs; final checks were rerun with durable ignored-cache logs. Independent consolidated review found no remaining P1/P2 issue. The final host build passed. Final scoped documentation validation passed for three documents, one Mermaid diagram and 58 local Markdown file links; the build log was formatted and `git diff --check` passed.

Actual browser acceptance used production web/API, a synthetic organization and two accounts in private disposable infrastructure, without documents or a provider. Supported API issuance created a settings-read-only key. Editing its issuer's role definition in the dashboard changed fresh key-only organization reads from 200 to 403, and restoring that definition returned 200. Assigning a custom restricted member role returned 403; session-only access remained forbidden. After restart the same restricted state and fresh 403 were verified again. Automatic approval review required confirmation for membership-role restoration; the user chose automated coverage instead. No subsequent browser restoration, member deletion/reinvitation or reissue is claimed. Member removal, direct fixture membership re-addition and supported fresh reissue passed in the HTTP suite; invitation delivery/acceptance was not tested in this change. The owner's dashboard remained usable, the final reloaded console was clean, and the owned two previews, four containers and temporary tab were removed. [The authorization guide](api-key-authorization.md) records the full recipe, exact boundary and actual coverage.

## Security follow-up — HTTP request body limits (issue #10)

- [x] Confirm unbounded non-upload/auth request parsing and review the installed Hono/Node/oRPC behavior.
- [x] Add a bounded pre-parser 1 MiB guard, with 26 MiB reserved for the four supported POST document upload/replacement routes.
- [x] Count actual visible stream bytes regardless of small/missing Content-Length, cancel/release safely on overflow and preserve CORS/version headers.
- [x] Cover stream/route boundaries and real HTTP chunking, all four multipart actions, a 25 MiB original and no mutation on rejected requests.
- [x] Run workspace/catalog/build/image validation and actual dashboard upload/replacement acceptance.
- [x] Finish independent review and documentation checks.
- [x] Deliver the separate PR from merged issue #8.

Implementation and automated/browser validation are complete on `codex/http-request-body-limit`, based on issuer-revocation [PR #32](https://github.com/SimonLoir/vectorix/pull/32), which passed both required CI checks and was squash-merged as `286b404`. The final #8 checks passed locally and its browser restoration/removal/re-addition/reissue controls were left to automated coverage at the user's request. Issue #8 was delivered and closed by that merge. The new guard needs no Prisma schema, migration or public DTO. [HTTP request limits](http-request-limits.md) records the implemented policy and actual acceptance, including the unchanged preflight behavior and Fetch adapter's bodyless GET/HEAD boundary.

Issue #10 touched `apps/api/src/http/request-body-limit.ts`, `apps/api/src/app.ts`, the focused HTTP tests, `apps/api/src/request-body-integration.ts`, core test registration and the API test script, plus `README.md`, `AGENTS.md`, the document-library entry-point note, the HTTP guide and this log. The guard runs after CORS and before Better Auth/oRPC, counts every exposed body byte regardless of a small/missing Content-Length, coalesces bytes into a growing bounded buffer, initiates cancellation without awaiting an unbounded hook, releases the reader, preserves accepted multipart bytes/headers/signal and returns sanitized transport-specific 413/400 with registry version headers. Preflight and adapter-hidden GET/HEAD/TRACE bodies are explicitly outside actual-stream counting; no raw-wire, timeout or concurrency guarantee is claimed.

Validation passed: 132 disposable core/RAG HTTP tests with seven-migration fresh/upgrade/replay/schema parity; nine focused guard tests, including actual chunked loopback HTTP; 23 workspace type checks; 23 lint tasks; 32 backend regressions; four production builds; all six image/runtime/infrastructure checks. All four real 2 MiB upload/replacement contracts passed, an exact 25 MiB original was queued, and oversized/near-miss requests made no auth/catalog/task mutation. Existing public file validation remained in force. Final independent runtime/test/documentation reviews found no remaining P1/P2 issue. Five changed documents passed formatting, two parsed Mermaid diagrams, 69 local Markdown file links and whitespace checks.

Actual dashboard acceptance used production web/API/workers with private disposable infrastructure and a synthetic manager. A 1.25 MiB Markdown upload reached ready status, displayed its marker in a bounded preview and downloaded with identical SHA-256. A second 1.25 MiB Markdown replaced it through the dashboard, published version 2 and downloaded with its own matching SHA-256; reload kept it ready/published and the console was clean. The original's normal seven-day retention remained; no retention soak is claimed. Unauthenticated production-preview HTTP declarations above the selected budgets returned sanitized 413 with CORS, version 1/revision 12 on versioned routes and the RPC envelope. Actual chunked and no-mutation evidence comes from the automated suites. The three previews, four containers, temporary tab and both verified downloads were cleaned. No live provider or application data was used.

HTTP body limits were committed as `0d357f5` and delivered in [PR #33](https://github.com/SimonLoir/vectorix/pull/33). Its exact-head catalog and six-image CI checks passed, and it was squash-merged as `6ec7550`, closing issue #10; local validation and dashboard acceptance above are complete.

## Security follow-up — canonical password-reset links (issue #17)

- [x] Confirm the request-header fallback and review the current mail callback and native reset flow.
- [x] Require a valid server-configured web base, preserve its path prefix and remove Origin/Referer/implicit-localhost fallback.
- [x] Validate configuration before native email lookup/token creation with the same sanitized unavailable response for known and unknown accounts; recheck inside the mail callback.
- [x] Cover precedence/invalid configuration, poisoned request headers, captured mail URLs, native one-time/expired tokens and session revocation with isolated tests.
- [x] Run workspace/catalog/build/image validation and a real dashboard reset-request journey with controlled local SMTP.
- [x] Finish independent review/documentation recording before delivery.
- [x] Deliver a separate PR from merged HTTP body limits.

Implementation and final automated/browser validation are complete on `codex/password-reset-origin`, based on HTTP body limits [PR #33](https://github.com/SimonLoir/vectorix/pull/33), which passed its required checks and was squash-merged as `6ec7550`. Existing deployment URL precedence (`VECTORIX_WEB_URL`, legacy `WEB_URL`, legacy `APP_URL`) is preserved only for non-empty valid configuration; an invalid configured higher-priority value must fail rather than silently selecting another source. Missing configuration must not fall back to headers or an implicit localhost URL. No schema or migration change is planned. SMTP configuration consistency and verified account email changes remain separate issues.

Issue #17 touches the auth before hook, `packages/auth/src/password-reset-url.ts`, the email callback, six focused tests, four core integration journeys/registration, the shared forgot-password form, three web dictionaries, test dependency/lock importer, `.env.example`, `README.md`, `AGENTS.md`, the new guide and this log. No migration or public DTO is added. The first non-empty selected server URL is authoritative; malformed authority, credentials, query/fragment delimiters, backslashes, raw C0/DEL and internal whitespace fail closed. Its prefix is preserved and token values remain query data. The native before hook validates before reset-account lookup/token creation, and the callback validates again before mail credentials/rendering. Request headers affect locale and native request policy, never the destination. The web form translates the 503 state in EN/FR/nl-BE.

Final checks passed: frozen offline install, 136 disposable core/RAG HTTP tests with fresh/upgrade/replay/schema parity, six focused URL/callback/native-memory tests, 23 workspace type checks, 23 lint tasks, 38 backend regressions, four production builds and all six image/runtime/infrastructure checks. Initial global types and Next container builds found weak ProcessEnv assignability; explicit three-key reads resolved it without casts, then final types/catalog/build/image passes succeeded. Independent source/test/delta review found no remaining P1/P2. The review also found raw-control normalization; C0/DEL rejection and focused/HTTP regressions cover it. NUL is tested through direct resolver objects; process.env HTTP cases use BEL/DEL because Node truncates NUL. New test delivery capture uses a scoped @repo/emails devDependency and only its three-line lock importer change.

Actual acceptance used production web/API and loopback SMTP in private disposable infrastructure. The English forgot-password form completed and SMTP captured its email. A separate cookie-free request with forged Origin/Referer/Host/forwarded values also delivered only a configured localhost link. Both query tokens privately matched the synthetic account's unexpired native verification records. After removing all canonical variables and restarting only the disposable API, known EN, unknown FR and known nl-BE form requests displayed their translated error, kept the form available and created no token/session/mail. Counts stayed at 2 verification rows, 1 session and 2 captured messages. An invalid selected primary URL with a valid legacy lower-priority URL likewise returned identical 503 for known/unknown requests and unchanged counts. No actual browser password change is claimed; isolated HTTP tests establish native one-time use, expiry, target isolation and session revocation. Locale persisted, initial English was restored, and the final reloaded console was clean. The three previews, four containers, temporary tab and raw SMTP capture were cleaned; token-free metadata remains in ignored cache. No external recipient, application data or embedding provider was used. [Canonical reset-link documentation](password-reset-links.md) records entry points, limitations and the full recipe.

Final issue #17 documentation checks passed: four changed documents, one parsed Mermaid diagram, 68 local Markdown file links, all 3,558 web/admin ICU messages and English/French/Belgian Dutch key parity. Source/dictionary/lockfile formatting and `git diff --check` passed. Final independent documentation review found no material accuracy gap. Delivery remains a dedicated PR; SMTP configuration consistency and email-address verification remain separate work.

Password-reset links were delivered in [PR #34](https://github.com/SimonLoir/vectorix/pull/34) as `571ca22`. Its exact-head catalog and six-image CI checks passed, and it was squash-merged as `571deab`, closing issue #17.

## Infrastructure follow-up — encoded Redis credentials (issue #23)

- [x] Confirm encoded WHATWG userinfo bypasses the native client URL decoder when passed as connection options.
- [x] Decode URL username/password exactly once, preserve raw standalone fallback and existing connection/lazy-queue behavior, and sanitize configuration failures.
- [x] Cover reserved characters, Unicode, literal plus/percent sequences, empty password fallback, malformed encodings and TLS/database options.
- [x] Exercise all three real queues/workers and their schedulers on owned authenticated Redis; wire this into CI.
- [x] Run workspace/catalog/build/image checks and independent review.
- [x] Verify a production dashboard upload/extraction/download on encoded Redis ACL credentials and clean owned resources.
- [x] Finish English documentation, Mermaid/link/format checks.
- [x] Deliver a separate PR.

Implementation and automated/dashboard acceptance are complete on `codex/redis-url-credentials`, based on merged reset-link PR #34 (`571deab`). Touched files are the pure Redis configuration helper, unchanged public queue entry points, six focused tests, the real Redis integration test and owned-container runner, API/root test scripts, the catalog workflow, `.env.example`, root/package documentation and this log. No schema, migration, public DTO, dependency, lockfile or application container policy changes are required. The helper retains previous host, port, database, protocol/TLS and retry parsing policy; this is not a general Redis URL-policy redesign.

Final automated checks passed: 23 workspace type checks, 23 lint tasks, 44 backend regressions (including six focused Redis cases), two real Redis test processes covering all three queue/worker/scheduler pairs with encoded ACL credentials and the raw default-user password, 136 disposable core/RAG HTTP tests with fresh/upgrade/replay/schema parity, four production builds and all six image/runtime/infrastructure checks. An initial lint check rejected a redundant async test callback; it now returns its promise directly and the final lint/real-Redis checks pass. Independent source/test/isolation review found no actionable P1/P2. No TLS handshake was exercised; `rediss:` is validated at option level.

Actual dashboard acceptance used production web/API/workers and four private disposable infrastructure containers. The Redis user/password contained reserved characters, Unicode, a literal plus and a literal percent sequence; its encoded URL took precedence over a deliberately incorrect standalone fallback. API `/ready` returned 200, all three workers started, and a private `ACL WHOAMI` observation matched the configured decoded username on database 15. All three scan queues had completed jobs and zero failed jobs at observation. A 301-byte UTF-8 Markdown upload reached ready/published version 1, showed its 299-character extracted text and marker, survived reload, and downloaded with SHA-256 `cc1ff6df6e3042a25e875048e410392c33a3d5d1bc24c5e8dc0bcdcba777e01a`, identical to the original.

The initial host standalone preview omitted the `public` assets copied by the production Dockerfile, causing a service-worker 404. Copying public/static assets and restarting only that owned web preview corrected the test harness; a fresh final tab showed the persisted ready document with no console warnings/errors. No product change was needed. The three previews, four owned infrastructure containers, two temporary tabs and verified download were removed. No application database, external mail recipient or embedding provider was used. [Redis configuration and acceptance](redis-connections.md) records the reproducible recipe and boundaries.

Final issue #23 documentation checks passed: four changed documents, one parsed Mermaid diagram, 82 local Markdown file links, Prettier/source formatting, shell syntax and `git diff --check`. No user-facing UI copy changed.

Redis credentials were delivered as `6a18d67` in [PR #35](https://github.com/SimonLoir/vectorix/pull/35). Both exact-head required CI checks passed, and the PR was squash-merged as `5e01c8e`, closing issue #23.

## Security follow-up — atomic superadmin mutations (issue #20, scoped slice)

- [x] Confirm seven audit writes outside the mutation transaction and owner predicates outside their member writes.
- [x] Group current-actor checks, scoped target reads, mutations, affected session cleanup and audits in retryable serializable transactions.
- [x] Preserve native organization-deletion/RAG cleanup boundaries and stop treating request forwarding headers as verified audit IPs.
- [x] Complete isolated audit-failure, success, actor-revocation, foreign-identifier and superadmin owner-concurrency tests.
- [x] Run final workspace/catalog/build/image checks and independent review.
- [x] Verify organization/feature mutations and audit inspection in production admin on private disposable infrastructure.
- [x] Finalize English documentation/diagram/link checks.
- [x] Deliver a separate PR.

The current implementation on `codex/superadmin-transaction-audit` uses the dedicated shared transaction helper and changes seven named handlers, two previously transactional actor checks and the audit helper. Root documentation links and this guide record the new boundary. No schema, migration, public DTO or dependency changes are planned. This slice protects concurrent superadmin owner operations only; the cross-path native owner/deletion protocol remains planned and issue #20 stays open. See [Superadmin transactions](superadmin-transactions.md) for concrete file references, the acceptance recipe, audit IP provenance and the deferred-guard design constraints.

Issue #20 scoped validation passed: 23 workspace type checks, 23 lint tasks, 44 backend regressions, 150 disposable core/RAG HTTP tests with fresh/upgrade/repeat/parity, four production builds and all six image/runtime/infrastructure checks. Fourteen new HTTP journeys cover every affected mutation, audit rejection rollback, new/existing member paths, principal/session rollback, exactly one successful audit with null IP, foreign identifiers, three controlled superadmin owner races and actor revocation after real admission. Initial catalog setup failed because its admin-role target could not issue a key; the supported two-owner fixture fixed the test without weakening production guards. Scoped checks and the complete catalog rerun passed. Independent source/test review found no actionable P1/P2 in this slice. Full session/account comparisons avoid secret-bearing assertion diffs.

Actual production API/admin acceptance created and renamed a synthetic empty organization, forced a targeted audit failure, displayed the translated save error and confirmed unchanged persisted name/two audits after rejection and reload. Removing that fault, creating an unused feature with no organization grants and disabling it produced exactly four successful actions in the journal. The before/after organization values and unknown IP were inspected; journal reload retained four actions. The existing admin next-intl `ENVIRONMENT_FALLBACK` appeared in the browser/server and remains a separate timezone follow-up; no clean-console claim is made. The two previews, four private containers, temporary fault and tab were removed. No application data, external recipient or provider was used.

The separately reviewed [global owner-guard proposal](organization-owner-guard-proposal.md) remains design-only. It records the deferred native-deletion constraints, unvalidated post-initialization wrapping seam, role/snapshot/rollout limits and required cross-path matrix. No SQL migration or native guard was generated or applied; issue #20 remains open. The quoted migration-review rule will apply once a concrete supported wrapping seam and migration design are ready.

Final scoped issue #20 documentation validation passed: five changed documents, two parsed Mermaid diagrams, 88 local Markdown file links, source/prose formatting and `git diff --check`. Independent documentation review found no material gap. The separate owner-guard proposal was independently reviewed and still requires a proven native transaction seam before migration approval is requested.

The scoped superadmin transaction work was delivered as `d0acb91` in [PR #36](https://github.com/SimonLoir/vectorix/pull/36). Both exact-head required CI checks passed, and it was squash-merged as `e6c60cd`. Issue #20 remains open for the separately planned native ownership/deletion boundary.

## Runtime follow-up — shared dashboard timezones

- [x] Read the installed Next.js server/client and environment documentation in both affected applications.
- [x] Centralize the unchanged web timezone resolver in dashboard-core and reuse it from both web server entry points.
- [x] Resolve admin configuration on the server and pass the validated public zone through layout into its required provider prop.
- [x] Run workspace/backend/catalog/build/image validation and independent review.
- [x] Verify an owned DST audit fixture with UTC versus a different process zone, invalid fallback, three languages/reload and a production web smoke.
- [x] Finalize English documentation, diagrams and local links.
- [x] Deliver a separate PR from merged superadmin transactions.

Implementation and actual acceptance are complete on `codex/admin-runtime-timezone`, based on merged PR #36 (`e6c60cd`). Touched files are the new shared helper/public subpath, two web server imports and removed duplicate helper, admin request/layout/provider, `.env.example`, repository/package documentation, the earlier transaction acceptance note and this log. No dependency, lockfile, schema, migration or API DTO changes are required. The resolver body retains the existing trimmed Intl validation and Brussels fallback. Only a validated public string crosses the server/client boundary; locale resolution and language persistence are unchanged. Unrelated legacy explicit-date formatters remain separate work.

Final validation passed: 23 workspace type checks, 23 lint tasks, 44 backend regressions, 150 disposable core/RAG HTTP tests with fresh/upgrade/repeat/schema parity, four production builds and all six image/runtime/infrastructure checks. Independent source review found no actionable P1/P2. The production code was frozen before these checks and no implementation-mirroring unit test was added for the unchanged resolver move.

Actual acceptance used production API/web/admin, four private disposable infrastructure services and a synthetic audit fixture at `2026-03-29T01:30:00.000Z`. Process TZ remained Pacific/Honolulu. With runtime UTC, the same instant displayed 01:30 in EN/FR/nl-BE and remained 01:30 in persisted Belgian Dutch after reload. Restarting only web/admin with an invalid zone, on the same builds, displayed 03:30 in Belgian Dutch and restored English, proving the Brussels DST fallback. The initial English locale was restored, and production web showed its authenticated dashboard in Belgian Dutch then English after reload. Both final browser consoles were empty; the initial/invalid web/admin server logs had zero ENVIRONMENT_FALLBACK occurrences. Empty/missing/padded settings were not separately browser-exercised. This is provider/import acceptance, not a claim that every legacy formatter now honors the configured zone.

The three previews, four owned infrastructure containers and two tabs were removed. No application database, external mail recipient or embedding provider was used. [Dashboard timezone configuration and acceptance](dashboard-timezones.md) and the [dashboard-core package guide](../packages/dashboard-core/README.md) record concrete entry points, lifecycle and component-specific limits.

Final timezone documentation validation passed: six changed documents, two parsed Mermaid diagrams, 111 local Markdown file links, source/prose formatting and `git diff --check`. Independent documentation review found no material gap. Existing ICU dictionaries were unchanged.

The timezone correction was delivered as `f3a8a8e` in [PR #37](https://github.com/SimonLoir/vectorix/pull/37). Both exact-head required CI checks passed, and it was squash-merged as `1527d7c`.

## M6a — Token-window indexing and rebuilds

- [x] Preserve the existing structure planner and add deterministic versioned token windows.
- [x] Wire saved-profile admission, worker preflight, retry and search to the exact strategy/version pair.
- [x] Add localized settings/help, explicit future-mode gates and canonical source inspection through the existing dashboard.
- [x] Complete focused Unicode/provenance/work-bound tests and real disposable API/provider lifecycle tests.
- [x] Run workspace/backend/catalog/build/image validation and independent review.
- [x] Verify first index, rebuild, chunk inspection, search and exact sources in the production dashboard with real Ollama/EmbeddingGemma.
- [x] Finalize English documentation, diagrams, local links and locale-message validation.
- [x] Deliver [PR #38](https://github.com/SimonLoir/vectorix/pull/38), with both required CI checks passing before squash merge as `a829d6e`.

Implementation and automated/browser acceptance are complete on `codex/m6a-token-window`, based on merged timezone PR #37 (`1527d7c`). Touched areas are `packages/chunking`, indexing services, collection fields/summaries, EN/FR/nl-BE dictionaries, compatible API revision 1.13.0, real-transport regression tests and documentation. No schema or migration changes are planned. The structure-utf8-v1 planner remains unchanged. Semantic and parent/child execution remain planned. See [Token-window indexing](rag-token-windows.md) for semantics, concrete entry points, acceptance prerequisites and actual verification.

M6a final validation passed: 23 workspace type checks, 23 lint tasks, 44 backend regressions, 23 chunking tests, 123 embedding-adapter tests, 162 disposable core/RAG HTTP journeys with fresh/upgrade/repeat/parity, four production builds and all six image/runtime/infrastructure checks. Twelve added HTTP journeys cover first indexing, canonical text/spans/estimates, accounting replay, current/foreign access, wrong-version/provisioning fences, quotas, replacement/rebuild retry, retained sources, future gates and all four hosted native protocols using controlled local vectors. Independent reciprocal source/planner/UI/test review found no remaining actionable P1/P2. The first catalog pass caught two stale revision assertions and a nonexistent task-field filter in the new fixture; test corrections, scoped API type/lint checks and the full final rerun passed. Production code was frozen before validation and was unchanged by those fixture repairs.

Actual production dashboard acceptance used three application previews and five private disposable infrastructure/model containers. Ollama 0.40.8/EmbeddingGemma retrieval verified its retained weight digest, 128 dimensions and context 2048. Uploading the 1,223-byte FR/EN/NFD/emoji Markdown source produced seven token-window chunks with the chosen 64/8/16/96 settings. English hybrid, French vector and post-reload keyword searches returned the indexed passages; exact preview retained all 1,167 characters and original download matched SHA-256 `776e5a41d8754e65cb5144ac3381afab1286cf911fb179df47268d2a35fe4e0a`.

A second collection reused that document, published two structure chunks and then saved token-window revision 2. The profile comparison was inspected, a keyword request after rebuild admission still returned A, and B activated with seven chunks/two retained old chunks/zero reservations. French hybrid search then returned B, while earlier results displayed the previous-generation notice. A source dialog captured before rebuilding downloaded the identical original after A retired. No retention clock was advanced or long retention soak claimed. Separate observation verified canonical ranges/hashes/estimates/byte bounds for all 14 token-window chunks across both active generations.

New help/summaries were inspected in EN/FR/nl-BE, Belgian Dutch survived reload, and initial English was restored. Unsaved semantic/parent-child selections showed their planned-mode gate and were cancelled. Both consoles were empty. Replacement/provider-failure/retry, quota and permission-negative behavior were covered by automated HTTP tests, not separately repeated in the browser. All three owned previews, five owned containers, two tabs and verified downloads were removed; the existing model volume was preserved. No application database or paid provider was used.

Final M6a documentation validation passed: seven changed documents, eight parsed Mermaid diagrams, 121 local Markdown file links, 3,570 ICU messages with locale key parity, source/prose formatting and `git diff --check`.

## M6b — Durable semantic chunking

- [x] Prepare the additive schema and persistence/work-accounting design for independent review.
- [x] Obtain explicit user approval to generate the migration and test only disposable databases.
- [x] Implement and independently review pure unitization, float32 distances, percentile ties and native batch observation; fix contained-overlap windows with focused regressions.
- [x] Generate and verify the reviewed migration, supplementary constraints and organization cleanup guards.
- [x] Complete durable planning/checkpoint/usage orchestration, successful continuations, capacity admission and cleanup.
- [x] Complete separate compatible quota APIs and localized web/admin controls.
- [x] Validate crash/retry, quota contention, late results, current/foreign authorization, source retention and all five native protocols.
- [x] Run workspace/backend/catalog/build/image validation and final independent review.
- [x] Verify semantic first indexing, chunks/search/sources, threshold rebuild and usage/quotas through the production dashboard with real Ollama.
- [x] Finalize documentation/diagrams for delivery through a separate PR.

Delivered in PR #39, squash-merged as `646003f` after both required checks passed on head `a759bfe`. Work used `codex/m6b-semantic-chunking`, based on merged M6a PR #38 (`a829d6e`). The [semantic guide](rag-semantic-planning.md) describes the implemented protocol, migration and reproducible acceptance recipe. The user approved migration generation and disposable-database tests after independent review. M6c parent/child context and M7 remain pending.

Touched areas: `packages/chunking/src/semantic-*.ts` owns deterministic geometry and hashes; `packages/embeddings/src/batch-observer.ts` observes bounded native batches without changing their wire protocols. `packages/db/prisma/models/rag-semantic.prisma`, related additions and `20261028000000_rag_semantic` own plans, work evidence and capacity. Focused indexing modules under `packages/routers/rag/src/services/indexing/semantic-*.ts` connect saved source/profile bindings, admission, checkpointing and late usage settlement; `task-scan.ts` prioritizes bounded actual reservation holders. Separate semantic quota contracts/handlers preserve the existing strict six-field quota object. Localized collection settings, task/usage views and admin quota controls live in existing web/admin feature directories.

Final automated validation passed 23 workspace type checks, 23 lint tasks (existing warnings), 44 backend regressions, 45 chunking tests, 138 embedding-adapter tests, four production builds and all six production images with infrastructure checks. `pnpm test:catalog` passed 182 HTTP journeys, fresh/upgrade/repeat migrations, schema parity, 45 direct supplementary SQL assertions on each fresh/upgraded database and two actual PostgreSQL admission/delete lock races. Reviews identified and fixed contained-overlap windows, a nullable SQL usage constraint, late-result lease renewal after revoked authority, reservation holders delayed behind fresh tasks, and policy-increase contention. Focused regressions and the final complete pass cover these fixes. Hosted providers used controlled native HTTP fixtures; paid connectivity remains unverified.

### Actual production-dashboard acceptance

Run `2bcb9c865bde` used four production previews and five owned isolated containers, with real Ollama `0.40.8` and `embeddinggemma:latest` digest `85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1`, retrieval preset and 128 dimensions. Browser upload/READY extraction/attachment used a 6,403-byte FR/EN Markdown source (6,324 UTF-16 units), with topic changes, decomposed accents, emoji and a final marker. Its SHA-256 was `38cedabca1ca21e0dc265ba6f93ec9c86a73e96d0e6293923b40c9c13ea1cd41`.

A semantic profile at percentile 90 and target/overlap/min/max `128/16/32/192` published 20 chunks. The dashboard showed 75 accepted units, two successful continuations, one attempt, a sealed plan and zero outstanding reservations. All chunks and canonical positions were inspected. English hybrid search returned five results, including both keyword and vector ranks for `harbor tide`. A captured exact source was retained across a reviewed percentile-55 rebuild. Revision 2 activated 22 chunks; keyword search returned six results and French vector search five harbor passages. Its task likewise showed 75 units, two continuations, one attempt and zero reservations. All 22 rebuilt chunks and the final marker were inspected. Earlier results displayed their previous-generation notice, and the captured source reopened/downloaded after cutover with the same SHA-256 as the pre-cutover download. No partial `32/75` browser state or old-generation search during this brief rebuild was captured; automated HTTP tests cover those fences. No retention clock was advanced or retention soak claimed.

Organization usage and admin agreed on eight confirmed logical batches, 32,923 dispatched prepared-input bytes, 8,296 estimated tokens and 8,939 known native input tokens. Stored planning payload was 9,486 bytes; unused planning/work reservations and unresolved attempts were zero. Billed usage remained unknown for all eight batches. Admin rejected a cross-capacity violation, saved an 8,000-unit policy and preserved it after reload without changing the six legacy quotas. New help/task/usage/admin labels and locale-aware counters were inspected in EN/FR/nl-BE; Belgian Dutch persisted after reload and English was restored. All three browser consoles were empty. Automated tests cover negative permissions, revocation, retries, controlled provider failures and capacity contention. No application database, application `.env` or paid provider was used.

Read-only observations independently verified every saved plan, canonical range/text/source intersection, text/prepared hash, profile/model/unit binding and both physical vector publications. Child accounting matched 22 active plus 20 retained chunks. All four owned previews, five owned containers, three owned browser tabs and both hash-verified downloads were removed; the pre-existing Ollama model volume and user tab were preserved. Final documentation validation passed ten changed documents, eleven Mermaid diagrams, 162 local Markdown file links, 3,813 ICU messages with locale-key parity, formatting and `git diff --check`.

## M6c — Parent context

- [x] Independently review the minimal schema expansion and complete dashboard journey.
- [x] Prototype the generic application-layout sealing protocol on disposable PostgreSQL; reproduce the lock-only snapshot defect and verify its statement-level row-touch correction.
- [x] Prepare the [parent-context guide](rag-parent-context.md) and four-field delta in `packages/db/prisma/models/rag-indexing.prisma` for review.
- [x] Obtain explicit approval before generating an M6c migration or applying it to disposable databases.
- [x] Implement pure grouping, child-only materialization/embeddings/accounting, immutable layouts, bounded search/context projection, retries/cleanup and localized dashboard journeys.
- [x] Validate real-schema fresh/upgrade/repeat/parity, SQL constraints and concurrent sealing/cleanup/organization guards on disposable databases.
- [x] Complete automated HTTP/primitives/backend checks, types, lint, builds and all six image checks.
- [x] Verify real Ollama structure/token/semantic child/context previews, FR/EN searches, a parent-size rebuild and exact old sources after cutover.
- [x] Verify EN/FR/nl-BE/reload, admin usage/help, clean owned browser consoles and preview cleanup.
- [x] Deliver the reviewed PR with actual evidence and limitations.

Implementation is on `codex/m6c-parent-context` from merged M6b (`646003f`). The independently reviewed model/protocol received explicit user approval before additive migration `20261029000000_rag_parent_context` was generated and tested only on disposable databases. Nullable generation context version and canonical chunk bounds preserve historical rows without a fabricated backfill. Context-only parents have no embedding input hash. API revision 1.15.0 adds optional parent context, canonical child bounds and bounded parent-underfill metadata while preserving the matched child ID/text/scores/source receipt and old DTO fields.

Concrete entry points are `packages/chunking/src/parent-context.ts`; indexing `generation-profile.ts`, `chunk-materialization.ts`, `index-document.ts`, `chunk-projection.ts`, `search-representatives.ts`, `search.ts`, `views.ts`, `sources.ts` and `cleanup-index.ts`; versioned `rag/indexing-types.ts`/`indexing.ts`; localized web chunk/search/profile components and dictionaries; `apps/api/src/rag-tests/parent-*.ts`; and `tests/catalog/parent-context-*`. Parents are committed separately before children, canonical parent-enabled rows are immutable from insertion, and the complete application layout reaches `SEALED` before external vector publication. Only children enter native final embeddings, lexical/vector ranking, manifests and searchable quota counters. Runtime admission bounds compact provenance to 32 MiB; the SQL backstop intentionally allows 64 MiB of spaced `jsonb::text`, without increasing the runtime cap. SQL projection limits child/context spans to 64 before database transfer. Current capability rechecks also prevent a manager downgraded to reader from receiving captured unpublished preview rows or totals.

The initial generic PostgreSQL 18.6 prototype passed eight proof groups on a uniquely owned disposable container, then removed it. SELECT locking alone reproduced a stale SERIALIZABLE zero-row seal despite two committed READ COMMITTED chunk rows. A statement-level candidate `updatedAt` touch made the stale sealer abort/retry, made an insert waiting behind a seal reject/roll back, and bounded a 2,000-row/two-owner insert to two touches. Canonical updates, frozen writes/reopening, forbidden live cascades and legitimate CLEANING/CLEANED teardown were also checked. This preparatory prototype is distinct from the final real-schema and application validation.

Final automated validation passed: 36 parent SQL proofs on each fresh/upgraded database, repeat deployment and Prisma parity, seven actual parent races, all 206 catalog/core/RAG HTTP tests, 56 chunking tests, 138 embedding tests, 44 backend regressions, 23 type-check tasks, 23 lint tasks with existing warnings, four application builds and all six image checks. HTTP coverage includes all 15 strategy/provider combinations with controlled native responses, exact child-only input/manifests/accounting, partial parent materialization/retry, historical sealed semantic hash replay, deduplication before topK, bounded underfill, 70-paragraph real DOCX provenance, current/foreign/grant/key access, manager-to-reader preview downgrade, rebuild/source retention and real cleanup. Hosted fixtures establish protocol/application behavior, not paid connectivity or relevance.

Actual production browser acceptance used isolated application/vector PostgreSQL, Redis, private S3, production web/admin/API/workers and real local Ollama/EmbeddingGemma. The synthetic `m6c-topics.md` source contained 6,400 UTF-8 bytes and 6,321 UTF-16 code units, SHA-256 `0fe04aae5df652fe7ef8d02a1061fe8130be8f2dd14410e2c5c140fbfb0da669`. Structure, token-window and semantic collections became active with 19, 19 and 20 children respectively; child/context preview reached the final marker for token and semantic. English structure hybrid returned five results in 179 ms; French token vector returned three in 219 ms; French semantic hybrid returned three in 163 ms with expanded parent range 5114–6320. These are individual observations, not a benchmark.

Changing the structure parent maximum from 512 to 256 admitted B while an actual keyword search still served A with two results in 77 ms. B then became active with 19 children and 11 parents, replacing A's 19 children and five parents. English B hybrid returned ten results in 126 ms, including an expanded 237-token-estimate parent at 4501–5199. A's captured source reopened after B activation; both original downloads were 6,400 bytes and matched the original SHA-256. Independent read-only database/vector observation replayed canonical plans and checked all child/parent text, ranges, provenance, source/profile hashes, parent links/suffix/caps, empty parent lexical vectors, absent parent embedding hashes, physical child-only manifests and accounting. A/B child geometry and text/prepared-input hashes were identical. Each exact vector table held only its 19/19/19/20 children with one publication per generation; no observer provider/S3 request or `.env` read occurred.

Semantic indexing completed 75 units through two continuations in one attempt. Four successful logical native batches recorded 16,379 prepared bytes, 4,127 estimated input tokens and 4,447 native input tokens, with zero unused/in-flight reservations or unresolved attempts; the stored plan payload was 4,705 bytes. Persisted attempt totals matched organization accounting. New child/context/dedup labels were observed in EN/FR/nl-BE, Dutch survived reload and English was restored. An English `harbor tide` query in Dutch returned five unique semantic parents in 129 ms with localized underfill. Admin quotas/help and the same usage totals were inspected in all three locales. All four owned browser warning/error consoles were empty. Negative permissions, injected failure and retry remained automated-only in this browser run.

Cleanup stopped four owned preview processes, removed five owned containers, closed created tabs 14–17 while preserving the user's existing tab 3, and removed only the two synthetic downloads after exact path/hash checks. The named Ollama model volume was preserved. A's normal source-retention grace was preserved at the observation point; no clock advancement, retention soak, paid-provider connectivity, relevance quality or load acceptance is claimed. Independent runtime/schema review completed without outstanding P1/P2 findings. Delivered as `50fea76` in [PR #40](https://github.com/SimonLoir/vectorix/pull/40); `catalog` and `smoke` passed on that exact head before squash merge as `f891144`.

Final documentation validation passed seven changed documents, eight parsed Mermaid diagrams, 149 local Markdown file links, 3,849 ICU messages with locale-key parity, formatting and `git diff --check`.

## M7a — Collection freshness and synchronization recovery

- [x] Independently review the existing ACTIVE/initial catch-up authority gap and a compatible recovery policy.
- [x] Create a dedicated branch from merged parent-context PR #40.
- [x] Implement configured automatic synchronization, current-rights checks, explicit self-adoption and monotone task fencing without a schema migration.
- [x] Expose current synchronization state and exact desired/searchable document freshness through compatible API revision 1.16.0 and the localized dashboard.
- [x] Preserve task-scoped retries, stronger pending-rebuild control, old publications, source holds and late semantic usage.
- [x] Validate shared library-only replacements, first-build catch-up, revocation, adoption/ABA/concurrency, keys/foreign identifiers and deletion on disposable infrastructure.
- [x] Run appropriate automated/build/image checks and independent source review.
- [x] Verify the complete real Ollama dashboard journey, locales, originals and cleanup.
- [x] Finalize English documentation, diagrams and actual acceptance evidence.
- [ ] Deliver the new PR and verify both exact-head CI checks before the authorized squash merge.

Implementation and automated/browser acceptance are complete on `codex/m7a-sync-freshness` from `f891144`. The [synchronization guide](rag-sync-freshness.md) records the chosen authority policy, compatibility boundaries, concrete entry points and actual acceptance. This slice reuses the existing nullable generation controller and task lease epochs; no schema definition change or migration is needed. M7 operational usage/latency, worker health, backup/restore, quality and load acceptance remain planned. No M7 operational-readiness completion is claimed.

Touched areas include generation acceptance/change dispatch/current authority/activation/retry services; transactional synchronization adoption/fencing and audit; bounded freshness metadata queries; explicit major-1 contracts and permission registration; three focused dashboard components, their existing index shells and EN/FR/nl-BE dictionaries; six focused synchronization test modules and compatible revision assertions. The two Prisma model edits correct comments only.

Final automated validation passed all 220 disposable HTTP/core/RAG tests, fresh/upgrade/repeat/parity checks, existing semantic/parent SQL/actual lock tests, 23 workspace type-check tasks, 23 lint tasks with existing warnings, 44 backend regressions, four production builds and all six image/infrastructure checks. Subsequent fixture-only scheduling edits passed scoped API types/lint/format and the final complete catalog. Independent production/test review found no outstanding actionable P1/P2. The initial catalog caught stale revision assertions and an initial activation-retry regression; production compatibility was restored while retaining the old worker test. The second pass reached all new journeys but positive fixtures stopped after six scans despite global activation pagination. Bounded state-driven real success waits fixed that test timing assumption; partial/native/lease/concurrency checks were preserved. Final result: 220 passed, zero failed.

Actual dashboard run 526637db886b used production web/API/workers, separate private PostgreSQL stores, Redis, RustFS and real Ollama 0.40.8/EmbeddingGemma with verified digest 85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1, retrieval preset and 128 dimensions. One controlled FR/EN document fed parent-enabled semantic and token-window collections. The source versions contained 2,833, 2,833, 2,867 and 2,850 bytes with explicit version markers, decomposed accents and emoji.

The library-only account's version 2 became current in both collections under controller A; the actual checkpoint verified no collection organization permission or member/group grant for that writer. Removing A's explicit semantic management grant then replacing with version 3 left semantic desired 3/searchable 2 with ACCESS_REVOKED and zero new semantic cost, while token became current 3. An actual second checkpoint preserved the intermediate state. Keyword search continued returning two version-2 contexts in 68 ms. After a limited role and explicit semantic read/manage grant were assigned through the dashboard, B captured version-2 sources, adopted by keyboard and explicitly retried from the document row. Adoption truthfully reported zero pending/running reassignments and left the failed task unchanged; retry published version 3. Both exact 2,833-byte old-source downloads matched SHA-256 4efa9e530f7f28d1c80c4e986e5b512be02083e7ec7124e9a7b1c9e7f312c969.

B's later version-4 replacement converged in both collections. Dashboard and read-only final observation agreed on semantic controller/executor B, token controller/executor A, both current 4 and no failed current work. A real partial semantic continuation at 32/43 units was observed; final tasks completed 43/43. Initial English hybrid returned two contexts in 827 ms; final French hybrid in Belgian Dutch returned two version-4 contexts in 120 ms with expanded 504-token-estimate parent range 0–1490. These timings are request observations, not a benchmark. New controls/help/confirmations and current-version dates were inspected in all three locales; translated confirmation dialogs were cancelled without repeating adoption. Dutch survived reload, English was restored and both warning/error consoles were empty.

Read-only proof replayed all eight retained canonical layouts and checked exact hashes/provenance, child-only vector manifests, 33 semantic and 36 token physical child rows across four publications each, one adoption audit and unchanged original event actors. Final accounting was semantic nine active/24 retained and token nine active/27 retained, with zero reserved chunks. Twelve confirmed semantic batches recorded 30,517 prepared bytes, 7,713 estimated input tokens and 9,095 known native input tokens; billed units were unknown. Plans/attempts matched persisted totals with no unused/in-flight reservations or unresolved attempts. Checkpoints were recorded during actual intermediate UI states; final mutable history was not used to fabricate them.

Cleanup removed all three owned previews, five owned containers, created tabs 18–19 and only two exact-path/hash-verified downloads. The user's tab 3, named Ollama volume and local admin Next type-import preference were preserved. No application .env/database or paid provider was used. The normal seven-day original delay/source grace was preserved without clock advancement or retention soak. Hosted protocols, process/crash negatives, role/key isolation and late provider/concurrent behavior remain automated coverage rather than additional live browser claims. M7 operational telemetry, worker health, backup/restore, relevance and load acceptance remain required.

Final documentation validation passed seven changed documents, nine parsed Mermaid diagrams, 156 local Markdown file links, 3,972 ICU messages with locale-key parity, formatting and `git diff --check`.
