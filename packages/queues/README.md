# Shared queues

`@repo/queues` supplies the shared BullMQ connection options and three queues: `notifications`, `documents` and `indexing`. The [worker entry point](../../apps/workers/src/index.ts) creates a worker for each queue and registers recurring scans. Durable notification, ingestion, cleanup and indexing state remains in PostgreSQL; Redis delivers the scan jobs.

## Entry points and lifecycle

- [Connection builder](src/redis-connection.ts): `buildRedisConnection({ REDIS_URL, REDIS_PASSWORD })` parses server configuration without opening a connection.
- [Rate-limit store](src/rate-limit.ts): `consumeRateLimit(key, windowSeconds, max, policy?)` atomically admits one request. The default `LAST_ALLOWED` preserves native authentication semantics: allowed hits renew the deadline, rejected hits do not. Explicit `FIXED` keeps the first-hit deadline in a separate Redis namespace. The outage fallback preserves both policies separately, with a shared 10,000-entry bound, an incremental 64-entry sweep and refusal on saturation rather than eviction of live budgets. It is per process and does not provide distributed limits while Redis is unavailable. Reconnection is request-driven, with one fixed warning. `closeRateLimitStore()` closes its lazily opened connection. See [API rate limiting](../../docs/api-rate-limiting.md).
- [Package entry point](src/index.ts): exports `connection`, `QueueName`, `getQueues()` and `closeQueues()`. Connection options are resolved when the module loads; `getQueues()` creates and caches the three queues only when called. Importing the package does not itself open Redis connections. Invalid configuration can still fail during import.
- [Workers](../../apps/workers/src/index.ts): use the same exported `connection` for all three workers and `getQueues()` for their schedulers. Shutdown closes the workers separately, then closes the shared queues.
- [API health check](../../apps/api/src/app.ts): calls the notifications queue through `getQueues()`; [API shutdown](../../apps/api/src/index.ts) closes initialized queues.

For example, a server process can inspect the document queue and close the queues it initialized:

```ts
import { closeQueues, getQueues } from '@repo/queues';

try {
    const counts = await getQueues().documents.getJobCounts();
    // Use counts inside the server process.
} finally {
    await closeQueues();
}
```

Do not call `closeQueues()` after each request in a long-running API. It closes all initialized shared queues and resets the cache. Deployment connection changes require restarting consumers so they resolve the new options.

## Credentials and connection options

URL usernames and passwords are percent-decoded exactly once before being passed to BullMQ. Encode each raw userinfo component separately when constructing `REDIS_URL`. A literal `+` stays `+`; it is not form data. Unicode credentials retain their authentication value. A literal credential containing `%40` must be encoded as `%2540` in the URL, so one decoding step returns `%40` rather than `@`.

A non-empty URL password takes precedence. A missing or explicitly empty URL password uses `REDIS_PASSWORD` as an already raw value: no decoding or trimming is applied to that fallback. An explicitly empty fallback remains an empty string. Malformed URLs or malformed percent-encoded userinfo throw only `Redis connection configuration is invalid.`; they do not select another URL or hide the error with the fallback password.

Existing host, port, database, TLS and retry policies are preserved: the absent-URL default is `redis://localhost:6379`, the default database is `0`, `rediss:` adds `tls: {}`, and `maxRetriesPerRequest` remains `null`. This credential fix does not add stricter protocol/database validation, TLS trust configuration or a new retry policy. See [Redis connections](../../docs/redis-connections.md) for examples, data flow and validation boundaries. Keep URLs and passwords in server configuration; do not log them.

## Tests

From the repository root:

```sh
# Six pure configuration tests; no Redis server is required.
pnpm --filter api exec tsx --test ../../packages/queues/src/redis-connection.test.ts

# Real authentication, queue, worker and scheduler round trips.
pnpm test:queues
```

The [unit tests](src/redis-connection.test.ts) are also registered in the [API backend test command](../../apps/api/package.json). They cover encoded and Unicode userinfo, exactly-once decoding, literal plus signs, password precedence and empty-password fallback, unchanged options, and sanitized malformed configuration.

The [isolated runner](../../scripts/test-redis.sh) requires Docker and the repository's Node.js/pnpm toolchain. It creates and removes its own loopback Redis container, uses database `15`, does not load `.env`, and never flushes an existing server. The [real Redis tests](src/redis-auth.integration.ts) run both encoded ACL credentials and raw standalone-password fallback. Each mode exercises ordinary jobs and schedulers on all three queues with real workers. These journeys passed on plaintext loopback Redis; they do not establish TLS deployment acceptance. Completed local validation and bounded actual dashboard acceptance are recorded in the [connection guide](../../docs/redis-connections.md).
