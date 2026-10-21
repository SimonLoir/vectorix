# Notification workers

The `notifications` BullMQ worker schedules an inspection of PostgreSQL delivery receipts every ten seconds. Each receipt is reserved with a token and an expiry time; expired reservations are reclaimed. Organization membership and preferences are rechecked before each delivery.

Transport errors are retried up to five times with increasing backoff, then retained as `FAILED`. A disabled preference or unavailable push subscription produces `SKIPPED`. Stored errors contain neither secrets nor raw provider responses. Email/push delivery is at least once: an interruption after sending but before recording success may produce a duplicate.

To start workers independently from the repository root: `pnpm exec dotenvx run -f .env -- pnpm --filter workers dev`. See `.env.example` for Redis, email transports, encryption, and VAPID configuration.
