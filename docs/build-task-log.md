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
- [ ] Independently review, commit, push and open the product PR; merge only after its checks pass.

Entry points and the full acceptance recipe/results are in [PDF/DOCX library](rag-rich-documents.md). No database change is required. Validation passed: Prisma, 20 type-check and 20 lint tasks (non-blocking warnings), 22 backend regressions, all four application builds, 43 parser tests, independent verification of 37 deterministic binaries, and 64 real core/RAG integration tests plus migration fresh/upgrade/repeat/schema parity. Independent review corrected prototype-extension acceptance and orphaned DOCX story/note extraction; seven targeted reference regressions were independently rerun.

Production browser checks cover real bilingual PDF upload/page navigation/source jump/original checksum; DOCX headings/sections, current headers/footnotes and 28,818-character bounded pagination; scanned replacement failure retaining the prior source; mixed-PDF blank-page warning; collection reader visibility, revoked-grant and cross-organization direct-URL denial; EN/FR/nl-BE and locale persistence; dashboard deletion followed by completed cleanup, confirmed S3 object absence and zero version reservation. No embedding, vector indexing or retrieval is claimed by this extraction milestone.

Final container validation after the active-reference correction: all six images and infrastructure checks passed, including the real bundled native PDF and isolated DOCX parser, API dependency exclusion, standalone web/admin assets, worker startup, fresh/repeated migrations, HNSW/DiskANN roles and private S3 restart persistence. Ten Mermaid diagrams, 47 local links and 111 document messages in all three locales validate. No application database was used.

The final fresh manager tab had no console warnings/errors. Temporary tabs, web/API/workers, their disposable PostgreSQL/Redis/RustFS and the checksum-verified test download were cleaned up. The pre-existing admin route-type import modification is preserved outside this commit.
