# Repository guide

Vectorix is a multi-tenant application foundation. Preserve its reusable authentication, organization, licensing, notification, and administration services as new features are added. The agreed RAG direction is recorded in [docs/rag-implementation-plan.md](docs/rag-implementation-plan.md); planned capabilities must not be described as already implemented.

## Workspace and architecture

- Implement changes on a dedicated `codex/*` branch and deliver them through a pull request. Do not commit or push implementation work directly to `main`, and do not merge a PR without an explicit request.
- Deliver product features as complete dashboard-testable journeys: include the relevant web/admin interface, API, persistence, background work, and permission/error states in the same milestone. Split PRs by usable actions rather than deferring the interface to a later phase. Backend-only foundations must be labeled as such and do not complete a product milestone.
- Use pnpm and Turborepo. The root `package.json` pins the supported Node.js and pnpm versions; install with `pnpm install --frozen-lockfile`.
- Runtime services are `apps/web`, `apps/api`, `apps/admin`, `apps/workers`, and the database migrator in `packages/db`.
- Local infrastructure is defined in `docker-compose.yml`: application PostgreSQL, Redis, a separate PostgreSQL vector store, and RustFS with a private bucket initializer. See `docs/rag-infrastructure.md` for configuration, role boundaries, and validation.
- Bound HTTP request bodies before authentication and RPC/REST parsing; preserve registry-derived document upload allowances, actual exposed-stream byte counting and sanitized transport errors.
- Put reusable logic in focused packages. `packages/routers/*` owns route implementations, `packages/api` composes routers, and `apps/api` wires HTTP transport, authentication, and request context.
- Keep one endpoint per route file. Router `index.ts` files should import and compose handlers rather than contain business logic.
- Split features into schemas, services, handlers, queue processors, page shells, forms, lists, dialogs, and shared types as needed. Avoid placing an entire workflow in one large file.
- Document exported functions, worker entry points, and non-trivial helpers with JSDoc when behavior, timing, idempotency, or cross-package constraints are not obvious from the signature.
- Reuse `packages/ui`, `packages/dashboard-core`, the shared ESLint configuration, and existing import aliases.

## Authentication, authorization, and organization isolation

- Reuse `@routers/utils/base` for explicitly public operations, `@routers/utils/authorized` for organization operations, and the existing superadmin guard for global administration.
- Resolve organization identity through authenticated context and scope database reads and writes accordingly. Validate related identifiers within the same organization; possession of an identifier never grants access.
- Register private operations in `packages/auth/src/permissions/`, including compound effects. Unknown private operations must fail closed. UI visibility is not an authorization check.
- Preserve session-only restrictions and explicit API key scopes. Key creation or updates must not grant permissions the issuer does not hold, and initialization must not grant existing keys automatic privileges.
- On every organization API-key admission, intersect stored permissions with the bound issuer's current roles; reject missing membership, unbound and legacy keys, and keep key contexts sessionless.
- Preserve organization suspension checks, member removal behavior, explicit feature grants, and audit records. Licensing provider failure or expiration must not grant access.
- Recheck the superadmin actor inside mutation transactions; keep scoped target checks, owner predicates, session cleanup and the audit write atomic. Request forwarding headers do not establish a verified audit IP.
- Keep `credentials: 'include'` in the web oRPC fetch link at `apps/web/contexts/orpc.tsx`.
- Build password-reset links only from validated server configuration; validate before native account/token work and again in the mail callback, never deriving destinations from request headers.
- Never log secrets, raw credentials, session tokens, or unsanitized provider responses. Reuse `encrypt()` and `decrypt()` in `packages/routers/utils/src/utils/encryption.ts` for recoverable provider secrets, with `ENCRYPTION_SECRET` configured on the server.
- Resolve credentials through `@routers/rag/credentials`: organization configuration precedes environment defaults, and existing collection revisions retain their saved binding. Fall back only when organization configuration is absent; invalid configured credentials must produce an explicit error. Keep provider configuration together rather than mixing keys and endpoints from different sources.
- Keep native embedding protocols and versioned capability snapshots in `@repo/embeddings`. Dispatch by the saved provider and preserve older snapshot variants. Distinguish verified local weight digests from hosted capability fingerprints; a hosted model name or configuration hash cannot attest to its weights. Keep discovery/probes tied to the saved profile revision.
- Keep private object I/O in `@repo/storage`, with bounded reads, sanitized failures, and operator-approved S3 endpoints. Follow each document version’s saved storage binding; changing the active credential must not retarget existing objects.
- Reuse `@routers/rag/access` for collection and library authorization. Check current membership, organization permissions, member/group grants, and API-key issuer/scopes before accessing content. Global catalog administration does not implicitly grant collection reading. Keep audit writes and catalog mutations in the same transaction.

## Database and schemas

- Use the shared Prisma client from `@repo/db`. The multi-file schema is under `packages/db/prisma/`; generated clients and Zod schemas under `packages/db/src/generated/` are ignored by Git and must not be edited manually.
- Prefer Prisma ORM operations. Do not use raw SQL to work around a stale generated client; regenerate with `pnpm db:generate`.
- Reserve raw SQL for operations Prisma cannot express, including the planned vector extensions and dynamic collection tables. Encapsulate it in the relevant adapter, parameterize values, validate generated identifiers, and explain why SQL is necessary.
- For internal model-derived validation, reuse generated schemas from `@repo/db/schemas` with `.omit()`, `.pick()`, and `.extend()`, and enums from `@repo/db/enums`. Versioned public DTOs are the explicit exception below.
- Edit only relevant schema files. Do not run global `prisma format` for a targeted change in the multi-file schema.
- Prepare schema changes for review; migrations are generated manually after review. Do not generate or apply migrations automatically as a side effect of unrelated work. Follow an explicit migration request when given, and never use `db:push` in production.
- Use transactions for related writes and preserve retry/idempotency guarantees. Keep durable task and delivery state in PostgreSQL; Redis is not its source of truth.
- Keep index generations, publication pointers, ordered change receipts, chunk accounting and exact-version source holds in the application database. Provider/vector/S3 I/O stays outside its transactions. Preserve native organization-deletion transactions and database cleanup guards; a late guard failure must roll back member removal.

## API contracts and versioning

- Versioning is global. URLs contain the major version (`/rpc/v1`, `/api/v1`); compatible revisions are represented by `Vectorix-API-Revision` and OpenAPI `info.version`.
- `packages/api/src/versioning.ts` owns release metadata. `apps/api/src/api-versioning/registry.ts` is the single registry of supported majors, with unique majors and exactly one current entry.
- Never break a supported major. Compatible additions increment its revision; breaking changes require a new major while retaining the old contract until its documented retirement.
- Public input/output DTOs are explicit, hand-written Zod schemas in `packages/api-contracts/src/v1/`. Keep them independent of generated Prisma schemas so database changes cannot silently alter a public contract.
- Use executable oRPC contracts with explicit inputs and outputs, and implement handlers through those contracts. Preserve operation parity between contracts and runtime routers; do not hide mismatches with casts.
- Consumers use exported `VectorixApiV1Client` and `VectorixApiV1Outputs` types, not types inferred from a mutable runtime router.
- Share services, queries, transactions, and integrations between API majors. Limit version-specific logic to contracts, input adapters, output mapping, and required compatibility behavior.
- All supported majors must work with the current database schema. Use compatible expansion, backfills, safe defaults or nullability, and adapters before removing old fields or adding constraints.
- When changing contracts, update route metadata and verify supported `/spec/v{major}.json` documents, `/spec.json`, `/api-versions.json`, and RPC/REST behavior. Keep routes and documentation derived from the registry.

## Frontend and runtime configuration

- Read environment variables on the server and pass only public values to client components through props or context. Never introduce `NEXT_PUBLIC_*` variables or expose secrets to the browser.
- Keep deployment configuration available at container startup. Do not bake deployment origins or private settings into frontend builds.
- Before changing Next.js code, read the relevant documentation shipped with the installed version under the application's `node_modules/next/dist/docs/`. Follow its current APIs and deprecation notices.
- Reuse shared UI primitives and preserve keyboard navigation, accessible labels, viewport-bounded dialogs, and internal scrolling.
- Localize new user-facing UI through `next-intl` dictionaries in English, French, and Belgian Dutch, including headings, placeholders, confirmations, errors, toasts, and accessible labels. Use complete messages with ICU interpolation/plurals and locale-aware number/date formatting rather than sentence fragments or a hardcoded locale. Web and admin share locale resolution in `@repo/dashboard-core/i18n/locale`; keep page headings reactive to language changes.
- Keep large lists and selectors bounded and filtered on the server. Invalidate affected query variants after mutations, and keep loading, error, and permission states explicit.

## Workers and containers

- Keep extraction artifacts and parser diagnostics in `@repo/documents`; heavy PDF/DOCX parsers remain workers-only and are injected into shared ingestion. Preserve legacy plain-text reads, immutable source offsets and full rich-artifact reservations. Never dereference document relationships.
- Keep heavy background processing in `apps/workers` and shared queue definitions in `packages/queues`. Queue messages should contain identifiers rather than secrets or full files.
- Design processors for retries, duplicate delivery, and interrupted execution. Recheck current organization access and delivery preferences before external notification sends; bound retries and sanitize stored errors.
- Keep a dedicated Dockerfile for each of the five services, using the repository root as build context. Web and admin use Next.js standalone output; API and workers contain their bundles and isolated production dependencies.
- Preserve the locked BuildKit pnpm cache at `/pnpm/store`, the current cache identifier, and `--store-dir=/pnpm/store`. Include all workspace manifests needed to resolve the frozen lockfile.
- Keep build tools out of runtime images, run as an unprivileged user, and fail builds on Prisma generation errors. Exclude local `.env` files from Docker contexts and inject configuration at startup.
- Publish through the existing workflow to `pxdv.be/vectorix/{web,admin,api,workers,migrator,postgres-vector}`. Preserve testing of all six images before publication and common commit tags across services; registry credentials belong in GitHub Actions secrets. Pull requests run checks without publishing images.

## Validation and documentation

- Finish a cohesive change before running one appropriate validation pass. Repeat or broaden checks when a failure or subsequent change warrants it.
- For implementation changes, validate the Prisma schema when relevant, run type checks, lint, relevant backend tests, and builds before committing. Root commands are `pnpm check-types`, `pnpm lint`, `pnpm test`, and `pnpm build`; use workspace filters for scoped work.
- Use the isolated `_test` database convention for integration tests. Cover organization isolation, direct identifiers, permissions, transactions, and retries where affected; never run destructive tests against application data.
- `pnpm test:catalog` owns disposable PostgreSQL/Redis/RustFS containers and verifies fresh migrations, upgrades, repeat deployments, schema parity, and core/RAG API journeys. It does not read the local `.env` or use application databases.
- Use browser verification for affected user journeys. For container changes, run `pnpm test:docker` where Docker is available and report any verification that could not run.
- Record each product milestone's dashboard acceptance recipe, prerequisites, expected outcome, and actual browser verification in its PR and build log. API tests or mocked providers alone do not establish a working dashboard or live provider journey.
- For documentation-only changes, review accuracy and local links, check formatting and `git diff --check`, and parse changed Mermaid diagrams. Application builds and tests are not required for prose-only edits.
- Write all documentation in English, including Mermaid labels. Include Mermaid diagrams when they clarify architecture, data flow, or workflows.
- Update documentation in the same change as the behavior it describes. Keep runtime configuration and setup in `README.md` and `.env.example`, and package-specific usage in the relevant package README.
- Update this guide when architecture boundaries or cross-package conventions change. Keep release history and domain-specific details in `docs/`, rather than growing this guide into a changelog.
- Maintain a checklist in `docs/` for implementation work, defaulting to `docs/build-task-log.md`, with status, touched files, and validation notes. Document integration entry points and data flow using concrete file references.
- Distinguish completed work, planned features, and validation that actually ran. Never present a mocked provider check or an unrun build as a successful live test.
