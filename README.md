# Vectorix

A multi-organization application foundation written in TypeScript. It includes a Next.js dashboard, a Hono/oRPC API, an administration panel, BullMQ workers, and a Prisma/PostgreSQL migrator.

## Local development

Requirements: Node.js 24, pnpm 11.25, and Docker Compose for PostgreSQL and Redis.

```sh
pnpm install --frozen-lockfile
pnpm setup:env
# Adjust .env if the default ports are already in use.
docker compose up -d
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

The initial feature catalog is empty. No business domain or demo data is installed. Models, contracts, permissions, and migrations cover only the application foundation.

## Repository structure

| Directory                                | Responsibility                                                       |
| ---------------------------------------- | -------------------------------------------------------------------- |
| `apps/web`                               | Dashboard, accounts, team, and notifications                         |
| `apps/api`                               | HTTP transport, authentication, and OpenAPI documentation            |
| `apps/admin`                             | Global administration protected by a superadmin session              |
| `apps/workers`                           | Asynchronous notification delivery                                   |
| `packages/db`                            | Schema, generated client, and migrator image                         |
| `packages/auth`                          | Better Auth and authorization policy                                 |
| `packages/api-contracts`                 | Versioned oRPC/Zod contracts                                         |
| `packages/api`                           | Router composition                                                   |
| `packages/routers`                       | Organizations, members, notifications, administration, and utilities |
| `packages/queues`, `packages/emails`     | Redis/BullMQ and email transports                                    |
| `packages/ui`, `packages/dashboard-core` | Shared components                                                    |

The API uses `/rpc/v1` and `/api/v1`. The initial contract version is `1.0.0`. The OpenAPI schema is available at `/spec/v1.json` and `/spec.json`, and the version registry at `/api-versions.json`. `/health` checks the process; `/ready` checks PostgreSQL and Redis.

## Configuration

All variables are documented in `.env.example`. Public values are read on the server and passed to the interface, without `NEXT_PUBLIC_*` variables.

Account registration and organization creation are enabled in the local example. Disable them with `ALLOW_ACCOUNT_CREATION=false` and `ALLOW_ORGANIZATION_CREATION=false` for an invitation-only deployment. Set URLs, trusted origins, secrets, the cookie domain, and WebAuthn settings for each deployment.

Email requires Resend or SMTP. Without a provider, notifications remain pending and fail after five attempts; users can still sign in. Web Push is disabled by default and requires a VAPID key pair and `ENCRYPTION_SECRET` for encrypted subscriptions. These transports are not simulated in production.

A license provider receives `GET {VECTORIX_FEATURE_PROVIDER_URL}/organizations/{id}/features` with an optional server token. It returns `{"features":{"reporting":true},"expiresAt":null}`. Cache duration and HTTP timeout are configurable. Manual mode, named `legacy` in the contract, requires explicit activation and grants in the administration interface.

## Validation

```sh
pnpm check-types
pnpm lint
pnpm test
pnpm build
```

Integration tests require a separate database whose name ends in `_test`. They create and remove their own accounts and organizations without deleting other data. External providers are disabled in these tests.

```sh
docker compose exec postgres createdb -U postgres vectorix_test
DATABASE_URL=postgresql://postgres:password@localhost:5432/vectorix_test pnpm --filter @repo/db migrate:deploy
DATABASE_URL=postgresql://postgres:password@localhost:5432/vectorix_test pnpm exec dotenvx run -f .env -- pnpm --filter api test:integration
```

## Deployment and migrations

The initial migration creates only the application foundation in a fresh database. For subsequent changes, edit the schema, generate and review a development migration with `pnpm --filter @repo/db migrate:dev`, then run `pnpm db:migrate` before deploying the applications. Do not use `db:push` against a production database.

```sh
docker build -f apps/web/Dockerfile -t pxdv.be/vectorix/web:latest .
docker build -f apps/api/Dockerfile -t pxdv.be/vectorix/api:latest .
docker build -f apps/admin/Dockerfile -t pxdv.be/vectorix/admin:latest .
docker build -f apps/workers/Dockerfile -t pxdv.be/vectorix/workers:latest .
docker build -f packages/db/Dockerfile -t pxdv.be/vectorix/migrator:latest .
```

Inject configuration when containers start and use PostgreSQL and Redis DNS names reachable from their network. The migrator is a one-off process that runs `prisma migrate deploy`. It does not run alongside the applications in `pnpm dev`.

Each application has its own Dockerfile, with the repository root as the build context. Web and admin run the Next.js standalone server and include its traced files, static assets, and, for web, the public directory. The API and workers include their bundles and production dependencies isolated by `pnpm deploy` from the lockfile. Optional dependencies are excluded from these two images to avoid Next.js/TypeScript peers and unused native accelerators; PostgreSQL and BullMQ use their JavaScript implementations.

All five images use Node.js 24 Alpine and an unprivileged user. pnpm and compilation tools remain in build stages. Prisma generation is required: any failure stops the build. No private configuration is copied into the images.

To build and test all five images with temporary PostgreSQL and Redis services:

```sh
pnpm test:docker
# Alternatively, with only Bash and Docker installed:
bash scripts/test-docker.sh
```

This test checks migrations, startup, API registration, Next.js assets, runtime configuration, worker job execution, and the absence of build tools in backend images. It publishes no host ports and cleans up its containers afterward. The GitHub Actions “Docker images” workflow runs the same test on every push to `main` and on pull requests.

### Image registry

The registry is `pxdv.be`, with repositories `vectorix/web`, `vectorix/admin`, `vectorix/api`, `vectorix/workers`, and `vectorix/migrator`. After successful tests on `main`, the workflow publishes the exact images just tested with `sha-<full Git SHA>` and `latest` tags. Pull requests run tests only.

Configure the GitHub Actions secrets `PXDV_REGISTRY_USERNAME` and `PXDV_REGISTRY_PASSWORD` with an account authorized to publish to all five repositories. While either secret is missing, tests remain enabled and publication is skipped with a warning. Once the secrets are configured, rerun the “Docker images” workflow on `main` or push a new commit to publish images.

To retrieve a published version:

```sh
docker login pxdv.be
docker pull pxdv.be/vectorix/web:latest
# For a reproducible deployment, use the same sha-<SHA> tag for all five services.
```

## Documentation

- [Repository conventions](AGENTS.md): architecture, authorization, API compatibility, development, and validation rules.
- [RAG implementation plan](docs/rag-implementation-plan.md): agreed V1 scope, architecture diagrams, proposed defaults, work packages, and acceptance criteria. These features are planned, not yet implemented.
- [Build and validation log](docs/build-task-log.md): completed template work and recorded checks.
