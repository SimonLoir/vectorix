# Versioned API rate limiting

This page covers issue #56. Every authenticated `/rpc/v1/*` and `/api/v1/*` operation built on `@routers/utils/authorized` passes through [`enforceApiRateLimit`](../packages/routers/utils/src/api-rate-limit.ts). The check runs after authentication and the organization-suspension check, and before permission checks, so a looping client is throttled even when it is denied. Counters are atomic Redis fixed windows from [`consumeRateLimit`](../packages/queues/src/rate-limit.ts), shared by every API replica.

## Budgets

| Bucket                                       | Key                                  | Default per minute | Variable                                                   |
| -------------------------------------------- | ------------------------------------ | ------------------ | ---------------------------------------------------------- |
| Every operation, per principal               | organization + API key ID or user ID | 600                | `VECTORIX_API_RATE_LIMIT_PER_MINUTE`                       |
| Provider-backed operations, per principal    | organization + API key ID or user ID | 60                 | `VECTORIX_API_PROVIDER_RATE_LIMIT_PER_MINUTE`              |
| Provider-backed operations, per organization | organization                         | 300                | `VECTORIX_API_ORGANIZATION_PROVIDER_RATE_LIMIT_PER_MINUTE` |

Provider-backed operations call an embedding provider on each request: `rag.indexing.search`, `rag.indexing.probe` and `rag.indexing.models`. A value of `0` disables that bucket. A value that is not a non-negative integer fails API startup. Dashboard sessions count against their user's budget, so the defaults leave headroom for normal browsing.

Every applicable bucket is counted on each request, including requests that end up denied, so retries during a denial still spend the budget.

## Response

An exhausted bucket returns HTTP 429 with code `TOO_MANY_REQUESTS`, `data.retryAfterSeconds`, and a `Retry-After` header on both RPC and REST. The header is set through oRPC's `ResponseHeadersPlugin` in [the runtime factory](../apps/api/src/api-versioning/runtime-factory.ts). The OpenAPI document (revision `1.20.0`) declares the 429 response and its header for every operation except the public health check. Dashboards show the existing localized `rateLimited` request error.

If Redis is unavailable, limits fall back to per-process windows and one sanitized warning is logged.

## Test and acceptance environments

`pnpm test:catalog` sets all three variables to `0`, because its functional journeys issue many calls per minute from one owner. The separately invoked capacity and quality acceptance workflows under `tests/acceptance/` run many concurrent searches and were not changed. Set the provider variables high enough, or to `0`, for those runs.

## Not included

Monthly per-organization query or embedding budgets, and their dashboard and superadmin views, are not implemented. They need a usage model and product decisions on limits. The existing document and chunk quotas are unchanged.

## Verification

- `apps/api/src/http/api-rate-limit.test.ts`: configuration parsing, per-principal and per-organization isolation, the organization provider bucket, and real RPC/REST runtime responses with status 429 and `Retry-After`.
- `packages/queues/src/rate-limit.test.ts` and `rate-limit.integration.ts`: the Redis window and its fallback.
