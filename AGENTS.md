# Repository guide

This is a reusable multi-tenant application shell. Keep domain features out of the base template.

- Use pnpm workspaces: web, API, admin, workers, and the database migrator.
- Keep authentication, organization isolation, explicit permissions, notification delivery and audit logs intact.
- Put route handlers in focused files under packages/routers; packages/api only composes them.
- Read runtime configuration on the server and pass public values through props/context. Do not use NEXT_PUBLIC_ variables.
- Use Prisma for database reads and writes. Generate production migrations manually after reviewing schema changes.
- Document configuration and behavior changes in README.md and docs/build-task-log.md.
- Validate the schema, typecheck, test relevant backend behavior, and build before committing.
