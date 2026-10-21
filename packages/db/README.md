# Database

PostgreSQL 18 and Prisma 7. The multi-file schema lives in `prisma/models/`, and the initial migration in `prisma/migrations/`. Generated TypeScript and Zod clients in `src/generated/` are ignored by Git.

From the repository root, run `pnpm db:generate`, then `pnpm db:migrate` against a fresh database. The migration script reads `DATABASE_URL`. To inspect the database, run `pnpm --filter @repo/db studio`.

Persisted data covers only accounts and sessions, organizations and roles, API keys, feature definitions/grants, notifications, and the administration audit log. Delivery receipts are durable; Redis does not replace their storage.
