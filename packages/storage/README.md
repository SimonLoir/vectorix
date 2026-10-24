# Private object storage

`@repo/storage` exposes bounded S3-compatible reads, private writes, HEAD checks and abandoned-upload deletion. API and workers supply a complete configuration resolved through `@routers/rag/credentials`; this package never discovers credentials itself. It intentionally uses explicit keys rather than the AWS default credential chain.

`VECTORIX_DEFAULT_S3_ENDPOINT` is allowed automatically. Add organization destinations to the comma-separated `VECTORIX_S3_ALLOWED_ENDPOINTS` on both API and workers. Entries must exactly match the configured URL after trailing-slash normalization. Each entry is parsed on its own: a malformed entry is skipped with one warning that names the variable and the entry's 1-based position (never its value), so it no longer hides later entries. The same parser, exported as `@repo/storage/endpoint-allowlist`, also handles `VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS`. Operators should allow only trusted endpoints; this is an endpoint allowlist, not a network sandbox or DNS-rebinding defense.

Calls have a 30-second timeout and at most two SDK attempts. Reads enforce the caller's byte limit against the response size and each streamed chunk. All SDK errors become a sanitized `StorageError`; provider responses and credentials are never logged. Originals use `application/octet-stream` and authenticated API downloads, with no browser-visible S3 URL or key.

The caller owns immutable keys, SHA-256 metadata, catalog transactions, reservations and fencing. See [document ingestion](../../docs/rag-document-library.md). Failed or interrupted writes can exist without a published extraction, so callers retain their reservation until successful publication or confirmed cleanup.
