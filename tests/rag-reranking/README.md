# Reranking database integration proofs

The catalog runner owns these tests. They require its migrated, disposable
`vectorix_catalog_test` database on `127.0.0.1` and its existing Redis, object and
vector fixtures. They do not read a local `.env` or contact a paid provider.

`schema-check.sql` runs transaction-local direct constraint probes and rolls back
all synthetic rows. It checks provider/model pairs, immutable revisions,
credential organization/provider binding, null-safe dispatch and terminal shapes,
UUID/principal bounds, finite usage, nonnegative counters, and accounting retention
after physical collection deletion. The runner applies this same file to its
fresh and upgraded databases.

`index.test.mts` reuses the catalog's native authentication setup and cleanup.
`accounting.mts` creates an isolated test organization and an empty active index
through existing native fixtures. It calls the actual profile, claim, dispatch,
settlement and maintenance services. A controlled PostgreSQL row lock proves both
concurrent claims overlap before testing capacity. A test-owned Cohere HTTP server
provides complete synthetic scores and usage for settlement; this establishes no
hosted-model quality or billing claim.

The service tests cover UUID replay (including alternate case), concurrent
capacity and dispatch, exactly-once settlement, unknown-to-known late usage after
revocation, cross-provider daily admission, and failures before dispatch. The
schema tests independently cover retained receipts after collection deletion.
Authorization and HTTP route behavior remain covered by the catalog's API suites.

Before the catalog executes this integration entry, type-check it with
`pnpm --filter api exec tsc6 -p ../../tests/rag-reranking/tsconfig.json --noEmit`.
The catalog invokes
`pnpm --filter api exec node --import tsx --test ../../tests/rag-reranking/index.test.mts`
inside its closed test environment. These are integration tests, not standalone
commands against application data. No acceptance result is claimed until that
catalog run completes.

For a focused repair pass, `VECTORIX_CATALOG_TEST_SUITE=reranking pnpm test:catalog` retains the same owned infrastructure, migration, restore, constraint and accounting checks but substitutes the dedicated HTTP journey for the full existing API matrix. It is not a full catalog acceptance result. CI and ordinary `pnpm test:catalog` keep the complete matrix.

`tei-schema-check.sql` adds 111 transaction-local constraint probes for native TEI profiles and separate endpoint credentials. The full and focused HTTP entries both run `apps/api/src/rag-tests/tei-reranking.ts`: 15 subtests cover endpoint CRUD/encryption/key rotation, organization and session boundaries, current scopes, metadata/permit drift, revocation during metadata I/O, immutable bindings, usage and legacy contract refusal. Its controlled scores prove protocol and accounting behavior, not actual model quality.
