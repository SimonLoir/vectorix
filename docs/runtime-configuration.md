# Startup configuration validation

This page covers issue #59. Before this change, the API and workers read about 74 environment variables lazily, each with its own defaults and parsing. A missing or unsafe value surfaced only on the first request that needed it, or never, as with the published `.env.example` placeholder for `BETTER_AUTH_SECRET`.

[`@repo/config`](../packages/config/src/index.ts) now validates the variables that protect data and destinations once, before either process opens a connection. The API and workers import `startup-config.ts` first ([API](../apps/api/src/startup-config.ts), [workers](../apps/workers/src/startup-config.ts)).

| Variable                      | API                     | Workers                                   | Rule                                                                             |
| ----------------------------- | ----------------------- | ----------------------------------------- | -------------------------------------------------------------------------------- |
| `DATABASE_URL`                | required                | required                                  | set                                                                              |
| `BETTER_AUTH_SECRET`          | required                |                                           | at least 32 characters, not a published placeholder                              |
| `ENCRYPTION_SECRET`           | required                | required                                  | exactly 64 hexadecimal characters, not a placeholder, not one repeated character |
| `BETTER_AUTH_URL`             | required in production  |                                           | HTTP(S) URL                                                                      |
| `TRUSTED_ORIGINS`             | required in production  |                                           | HTTP(S) URLs (exact-origin rules still apply in `resolveTrustedOrigins`)         |
| `API_URL`, `VECTORIX_WEB_URL` | format checked when set | `VECTORIX_WEB_URL` required in production | HTTP(S) URL                                                                      |

With `NODE_ENV=production`, any issue stops the process with a list of variable names and reasons; values are never printed. Elsewhere, issues are logged once as warnings so local development keeps working.

`packages/config/tests/runtime-config.test.ts` parses the repository's `.env.example` and checks that its placeholders still exist and are rejected in production, so the example file and the validator cannot drift apart silently. `scripts/test-docker.sh` now passes `VECTORIX_WEB_URL` to the production-mode containers.

## Not included

The remaining feature-specific variables (providers, quotas, limits, telemetry) keep their existing lazy parsing and explicit errors. Web and admin read their public settings at container startup through their own server code. Moving every read into one typed schema is a larger refactor than this fix.
