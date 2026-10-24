# Unit test discovery

This page covers issue #49. Before this change, root `pnpm test` ran only `api` and `@routers/utils`, and `apps/api` listed its test files by hand, so a new `*.test.ts` file was silently ignored until someone edited that list.

## How tests are found and run

```mermaid
flowchart LR
    A[pnpm test] --> B[turbo run test]
    B --> C[api: scripts/unit-tests.mjs]
    B --> D[@routers/utils: Vitest]
    B --> E[@repo/chunking: tsx --test]
    B --> F[@repo/embeddings: node --test]
    C --> G[Discover *.test.ts and *.test.tsx under apps/ and packages/]
```

- Root `pnpm test` is `turbo run test`, so every workspace package with a `test` script runs. The task is not cached, because the discovery runner reads files from other packages.
- [`scripts/unit-tests.mjs`](../scripts/unit-tests.mjs), the `api` package's `test` script, runs every `*.test.ts(x)` file under `apps/` and `packages/` with `tsx --test`. It skips:
    - integration suites (file names containing `integration`), which `test:integration` and `pnpm test:catalog` run against disposable services;
    - Vitest files (they import `vitest`), which their package's own script runs;
    - packages in its `OWN_RUNNERS` list (`chunking`, `embeddings`, `vector-store`), whose own scripts run them.
- `node scripts/unit-tests.mjs --list` prints the discovered files.
- `pnpm test:coverage` runs the same discovery with Node's built-in coverage report (`--experimental-test-coverage`). The report is informational; there is no threshold yet.
- `@repo/vector-store` needs the locally built vector image, so its script is `test:native` (run by the catalog workflow after building the image), not `test`.

To add a unit test, create a `*.test.ts` file next to the code or in a package `tests/` directory, using `node:test`. Nothing else needs editing.

## Separate suites

Document parsing (`pnpm test:documents`, native Poppler), Redis (`pnpm test:queues`), the catalog (`pnpm test:catalog`), Docker images (`pnpm test:docker`) and the acceptance guard scripts keep their own commands, because they need native tools, containers or explicit isolation.

## Not included

Browser end-to-end journeys (for example Playwright against the `test:catalog` stack) and coverage thresholds are not implemented. They need a CI browser environment, test fixtures and agreed thresholds; dashboard acceptance remains the manual recipe described in `AGENTS.md`.
