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

## RAG phase 2 — catalog and access

- [x] Verify merged phase 1 and the updated VM with the isolated infrastructure suite: HNSW/DiskANN, role boundaries, catalog migrations, private S3 operations, and restart persistence passed locally.
- [x] Add organization-scoped catalog models for credentials, storage locations, documents, collection configuration revisions, vector connections, groups, grants, key scopes, quotas, and audit. The user approved schema generation; the additive migration was tested against fresh and upgraded isolated databases.
- [x] Add versioned credential, group, collection, access, quota, and audit contracts and handlers, with bounded lists and explicit permissions.
- [x] Resolve complete organization credentials before environment defaults, encrypt secrets, retain destination references, and reject invalid configured credentials without fallback.
- [x] Intersect collection API-key scopes with the issuer's current membership and rights; test revocation, suspension, direct identifiers, and cross-organization access.
- [x] Enforce catalog quotas transactionally and record sensitive mutations without secrets.
- [x] Add real PostgreSQL integration coverage, verify API metadata/contract parity, run schema/type/lint/test/build/container checks, and document the phase in English with Mermaid.
- [ ] Commit and push the implementation on `codex/rag-catalog-access`, then open a PR against `main`.

Implementation entry points: `packages/db/prisma/models/rag.prisma` and `20261022000000_rag_catalog_access/migration.sql` define the stable catalog. `packages/api-contracts/src/v1/rag/` defines V1 revision 1; `packages/routers/rag/src/index.ts` composes the corresponding handlers. Shared credential resolution, access filters, transactions, and audit live in `packages/routers/rag/src/services/`. Organization key handlers bind scopes and issuers; the superadmin quota handler owns overrides. `scripts/test-catalog.sh`, `tests/catalog/`, `apps/api/src/rag-tests/`, and `.github/workflows/catalog.yml` exercise migrations and authorization.

The migration test verifies preservation of existing users, organizations, memberships, settings, and keys; no old key receives RAG privileges. Retention constraints are deferred until commit so organization cascades complete while referenced destinations remain protected. The integration suite covers empty-permission filtering as well as positive grants. Credential tests validate encryption and resolution using fixture values, without contacting embedding providers. No frontend journey or upload/search implementation is added in this phase.

Final local validation: frozen-lockfile installation and Prisma validation passed; all 18 type-check and 18 lint tasks passed (existing non-blocking warnings remain), as did 22 backend tests, 20 integration tests, and four application builds. The final six-image Docker suite passed startup/assets, pruned runtime dependencies, migration replay, worker execution, HNSW/DiskANN, database role boundaries, private S3 operations, and persistence after restart on the upgraded VM. Upstream pgvector/pgvectorscale emitted a non-failing TupleDesc warning; the PostgreSQL adapter emitted a non-failing pg query-concurrency deprecation warning. All test containers were removed. Six Mermaid diagrams, 14 local documentation links, changed-file Prettier formatting, shell syntax, and whitespace checks passed. No application database was migrated and no host application server was started.
