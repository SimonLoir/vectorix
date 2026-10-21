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

The vector database uses PostgreSQL 18.6 with pgvector 0.8.7 and pgvectorscale 0.9.1. RustFS 1.0.3 provides a private document bucket initialized by the one-off `s3-init` service. Each database and object store has its own named volume. Existing `.env` files need the new vector/S3 settings from `.env.example`; `setup:env` preserves existing files. See [RAG infrastructure](docs/rag-infrastructure.md) for connection roles, setup, and upgrade behavior. The [catalog and access APIs](docs/rag-catalog-access.md) and [catalog dashboard](docs/rag-dashboard.md) are implemented. Configure integrations, collection profiles, groups, grants, and scoped keys from the dashboard; inspect usage and audit there, and edit organization quotas in the admin panel. Uploads, ingestion, vector indexing, and search remain planned; each will ship as a complete dashboard-testable journey.

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
- RAG catalog dashboard and APIs: encrypted S3/Ollama/Cohere/Voyage credentials, groups, collection profiles with revision history and grants, scoped API keys, quota/usage views, and transactional audit. The admin panel edits organization quota overrides; document metadata currently has API access only.

The initial feature catalog is empty. No business domain or demo data is installed. The catalog migration adds empty RAG tables without granting existing API keys access.

## Repository structure

| Directory                                | Responsibility                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/web`                               | Dashboard, accounts, team, and notifications                                      |
| `apps/api`                               | HTTP transport, authentication, and OpenAPI documentation                         |
| `apps/admin`                             | Global administration protected by a superadmin session                           |
| `apps/workers`                           | Asynchronous notification delivery                                                |
| `packages/db`                            | Schema, generated client, and migrator image                                      |
| `packages/auth`                          | Better Auth and authorization policy                                              |
| `packages/api-contracts`                 | Versioned oRPC/Zod contracts                                                      |
| `packages/api`                           | Router composition                                                                |
| `packages/routers`                       | Organizations, members, RAG catalog, notifications, administration, and utilities |
| `packages/queues`, `packages/emails`     | Redis/BullMQ and email transports                                                 |
| `packages/ui`, `packages/dashboard-core` | Shared components                                                                 |

The API uses `/rpc/v1` and `/api/v1`. The current compatible contract revision is `1.2.0`. The OpenAPI schema is available at `/spec/v1.json` and `/spec.json`, and the version registry at `/api-versions.json`. `/health` checks the process; `/ready` checks PostgreSQL and Redis.

## Configuration

All variables are documented in `.env.example`. Public values are read on the server and passed to the interface, without `NEXT_PUBLIC_*` variables.

Account registration and organization creation are enabled in the local example. Disable them with `ALLOW_ACCOUNT_CREATION=false` and `ALLOW_ORGANIZATION_CREATION=false` for an invitation-only deployment. Set URLs, trusted origins, secrets, the cookie domain, and WebAuthn settings for each deployment.

Email requires Resend or SMTP. Without a provider, notifications remain pending and fail after five attempts; users can still sign in. Web Push is disabled by default and requires a VAPID key pair and `ENCRYPTION_SECRET` for encrypted subscriptions. These transports are not simulated in production.

A license provider receives `GET {VECTORIX_FEATURE_PROVIDER_URL}/organizations/{id}/features` with an optional server token. It returns `{"features":{"reporting":true},"expiresAt":null}`. Cache duration and HTTP timeout are configurable. Manual mode, named `legacy` in the contract, requires explicit activation and grants in the administration interface.

RAG credentials resolve a complete organization configuration before the environment fallback. Configure `VECTORIX_DEFAULT_{S3,OLLAMA,COHERE,VOYAGE}_*` as needed; an invalid organization configuration never falls back. Collection revisions retain their selected provider binding and destination. Embedding calls are not implemented yet. Defaults are 20 collections, 5,000 documents, 25 MiB per original, 10 GiB retained storage, and 100,000 chunks per collection. `VECTORIX_DEFAULT_RAG_*` changes deployment defaults; `/api/v1/superadmin/organizations/{organizationId}/rag-quota` sets an organization override. The admin organization workspace exposes these effective quotas and overrides under **Quotas RAG**. Only collection limits are enforced by the catalog milestone; byte reservations and chunk enforcement accompany ingestion.

## Validation

```sh
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

`pnpm test:catalog` starts disposable PostgreSQL and Redis containers on random loopback ports, tests a fresh install and upgrade from the initial schema, repeats deployment, checks schema parity and existing records, runs the core and RAG API journeys, then removes its containers and volumes. It does not load `.env` or start application servers. The “Catalog checks” GitHub Actions workflow runs it on pull requests and `main`, alongside schema, type, lint, and unit checks.

To run the integration suites manually, they require a separate database whose name ends in `_test`. They create and remove their own accounts and organizations without deleting other data. External providers are disabled in these tests.

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
- [RAG implementation plan](docs/rag-implementation-plan.md): agreed V1 scope, architecture diagrams, proposed defaults, and milestones with dashboard acceptance scenarios. Infrastructure and catalog APIs are implemented; the catalog dashboard is the first outstanding product milestone.
- [Build and validation log](docs/build-task-log.md): completed template work and recorded checks.
