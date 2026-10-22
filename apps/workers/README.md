# Background workers

The `notifications` BullMQ worker schedules an inspection of PostgreSQL delivery receipts every ten seconds. Each receipt is reserved with a token and an expiry time; expired reservations are reclaimed. Organization membership and preferences are rechecked before each delivery.

Transport errors are retried up to five times with increasing backoff, then retained as `FAILED`. A disabled preference or unavailable push subscription produces `SKIPPED`. Stored errors contain neither secrets nor raw provider responses. Email/push delivery is at least once: an interruption after sending but before recording success may produce a duplicate.

To start workers independently from the repository root: `pnpm exec dotenvx run -f .env -- pnpm --filter workers dev`. See `.env.example` for Redis, email transports, encryption, and VAPID configuration.

## Document ingestion and cleanup

The five-second document scheduler invokes `processDocumentIngestions(prisma, parseRichDocument)` followed by durable version cleanup. PostgreSQL owns leases, retries, reservations and publication; BullMQ schedules scans only. Workers recheck current access before parsing or publishing and follow each version's saved S3 destination.

PDF uses `/usr/bin/pdfinfo` and `/usr/bin/pdftotext` under `/usr/bin/prlimit`; install `poppler-utils` and `util-linux` on a development Debian/Ubuntu host. The workers runtime image installs Poppler and `util-linux-misc`. DOCX runs the bundled `dist/docx-thread.mjs` in an isolated Node worker. Both have bounded text, memory and time. No OCR or external relationship fetching occurs. See [rich document behavior and limits](../../docs/rag-rich-documents.md).

`pnpm test:documents` runs real/adversarial fixture and parser-bound tests. `pnpm test:catalog` verifies isolated database/HTTP/S3 journeys, and `pnpm test:docker` checks the actual production parser bundle and native runtime alongside all six images. Fixture reproduction instructions are in `tests/documents/fixtures/README.md`.
