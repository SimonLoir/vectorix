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
