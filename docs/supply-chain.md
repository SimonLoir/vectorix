# Supply-chain and image hardening

This page covers issue #47 and the image-hardening items listed in issue #19.

## Automated updates and analysis

- [`.github/dependabot.yml`](../.github/dependabot.yml) opens grouped weekly pull requests for npm (production and development minor/patch updates), GitHub Actions, each Dockerfile's base image and `docker-compose.yml`. Every update still runs the catalog and image workflows before review.
- [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) runs CodeQL `security-extended` queries for JavaScript/TypeScript on pull requests, `main` and weekly. Results go to the repository's code-scanning view.
- The Docker images workflow installs a pinned Trivy (v0.76.1) after `scripts/test-docker.sh` and scans all six tested images for fixed CRITICAL/HIGH vulnerabilities. The step is visible but non-blocking until findings are triaged.
- `pnpm audit --audit-level=high` in CI is part of the separate issue #15 change.

All actions stay pinned by commit SHA.

Docker updates for `node` exclude major-version changes. A Node major upgrade must coordinate the root `package.json` engine range, the catalog workflow's selected Node version and all five service Dockerfiles in one reviewed change, with the applicable validation repeated. Minor, patch and digest updates remain eligible for review; this restriction does not change the other base-image policies.

## Versioned lint policy on the Unicorn 78 engine

The Unicorn 78 engine uses a reviewed [version 63 policy snapshot](../packages/eslint-config/unicorn-63-policy.json), preserving the project's existing **unopinionated** rule selection, two core-rule overrides and 62 built-in globals. The [compatibility configuration](../packages/eslint-config/unicorn-63-compat.js) applies that policy before the existing Prettier, TypeScript, React and Next overrides. All 111 previously enabled checks remain backed by live implementations. New rule adoption is a separate policy change; the configuration does not inherit the expanded version 78 preset.

Two legacy IDs use their current implementations: `no-array-for-each` maps to `no-for-each`, and `prefer-dom-node-dataset` maps to `dom-node-dataset`. The removed `no-hex-escape` implementation needs a small [compatibility rule](../packages/eslint-config/no-hex-escape.js) with the [upstream MIT notice](../packages/eslint-config/no-hex-escape.LICENSE), because the replacement rules omit the old JSX and custom-tagged-template checks. A local plugin clone supplies these implementations without mutating the imported plugin or adding a version 63 dependency.

Explicit supported options retain fractional digit groups of three, comment-only file checks, the previous ignored-element threshold and small or unknown-size Set candidates. Fallback-expression checking stays enabled to retain legacy alias-declaration checks. Ternary checks retain `always`, with the optional varying-base and computed-member checks disabled. This preserves configured policy and the selected legacy coverage; upgraded implementations can still add diagnostics or safety exclusions. It does not promise identical results for every possible program.

Run the produced-configuration and real ESLint RuleTester regressions with:

```sh
pnpm --filter @repo/eslint-config test
```

All 55 focused tests pass, covering all 25 lint workspaces, representative TS and TSX files, the exact active rule set, live aliases, changed defaults and hexadecimal escapes in strings, JSX, tagged templates and regular expressions. The initial expanded-preset inventory records 397 errors and 48 warnings; the compatibility-only inventory retains 42 errors for separate review.

A bounded manual cleanup preserves lazy evaluation, adds explicit undefined defaults while retaining existing null guards, and uses an ordered three-state Set. Saved S3 `false` values remain false. Two metadata value validations retain their existing `Error` class and message through narrow, explained lint exceptions. No broad autofix or `PURE` annotation is used.

The combined validation passes all 25 workspace type and lint checks: the full pass covers the unchanged workspaces, followed by whole-web checks after the final two web-only expressions. Existing lint warnings remain at 48, with zero errors. All six root unit tasks pass (505 cases, including the 55 lint-policy cases), and API, workers, web and admin build in sequence. The original and intermediate lint failures remain recorded in [the build log](build-task-log.md#unicorn-78--versioned-lint-policy-compatibility). Both Next declarations and the lockfile are restored exactly, and the fresh private compiler cache is removed. This validates the lint-engine migration; no native application or browser acceptance is claimed.

## Images

- Every `node:24-alpine` stage, and the Compose `postgres:18-alpine` and `redis:8-alpine` services, are pinned by multi-architecture index digest, alongside the tag for readability, as RustFS, aws-cli and postgres-vector already were. Dependabot proposes digest updates.
- Application files in the API, workers, web, admin and migrator runtime images are copied root-owned (no `--chown`). The unprivileged runtime user can read and execute its code but cannot rewrite it. Web and admin get a single writable `.next/cache` directory for the Next.js cache.
- API, web and admin declare a `HEALTHCHECK` that uses Node's built-in `fetch` against the local port (`/health` for the API, `/` for web, `/sign-in` for admin; these pages render without reaching the API, so an API outage does not mark the dashboards unhealthy), so no extra tools are added. A redirect counts as healthy; a 5xx or connection failure does not. Workers have no HTTP listener and the migrator is one-shot, so neither declares one.

## Behavioral image checks

[`scripts/test-docker.sh`](../scripts/test-docker.sh) keeps its existing six-image, parser, database, worker and frontend checks. Its additional [runtime permission probe](../tests/docker/runtime-hardening.mjs) runs in each of the five service images as the configured user, with networking disabled and without a read-only filesystem override. It requires a nonzero actual UID, root-owned selected application directories/files, refused directory creation and refused write-only opens of packaged entry points/configuration. Existing application bytes are never overwritten. This tests representative protected paths, not every dependency file or a fully read-only container filesystem.

Web and admin must also create, read, overwrite, rename and delete a private temporary cache entry under their actual `.next/cache`. The running API/web/admin containers must reach Docker's actual `healthy` state without replacing their configured health command or interval. The API runs on the smoke-only nondefault `PORT=3101`; existing authentication and frontend checks use that same private-network address. This would fail a health command stuck on its default port.

These health checks establish local process/HTTP liveness, not database readiness, complete worker health or RAG/provider readiness. The integrated checkout passes the complete local six-image script on commit `09e76c4331b5b63683584c2dee68e5cacc1510ba`: all five service permission probes, both Next cache probes, all three actual Docker health checks (including API port 3101), configuration startup probes and the existing parser, frontend, worker, database/vector and private-S3 checks. The run completes in 240.293 seconds; only its own temporary resources and images are removed. Both host Next declarations retain their original bytes, mode and absence. CodeQL and Trivy execution/results require their separate GitHub workflow runs; the presence of pinned workflows does not establish a clean security analysis or vulnerability-free image.

The first GitHub CodeQL execution on `d98fced` completes, but its separate security check reports a new file-system race in the smoke helper's path-stat-before-open sequence. The helper is corrected without suppressing analysis: it attempts write admission directly with `O_NOFOLLOW`, then verifies root ownership through `fstat` on an opened read descriptor, closed in `finally`. Packaged code is never written or truncated. Independent source review is CLEAR; the repeated six-image script passes in 232.260 seconds with all five permission probes, both writable-cache checks, all three actual health checks and all existing infrastructure checks. Its owned resources are removed. New final-head CodeQL/security and catalog/image CI results remain required before merge.

## Not included

- SBOM and provenance attestations, and cosign keyless signing, for images published to `pxdv.be`. They require deciding whether the registry stores OCI referrers and switching publication to `docker buildx --push` with `id-token: write`, which pull-request checks cannot validate.
- Secret scanning, which is a repository setting (GitHub secret scanning and push protection) rather than a workflow.
- Running Poppler as a separate uid (issue #19), which needs a privilege or deployment decision; see that issue.
