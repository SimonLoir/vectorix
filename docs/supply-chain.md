# Supply-chain and image hardening

This page covers issue #47 and the image-hardening items listed in issue #19.

## Automated updates and analysis

- [`.github/dependabot.yml`](../.github/dependabot.yml) opens grouped weekly pull requests for npm (production and development minor/patch updates), GitHub Actions, each Dockerfile's base image and `docker-compose.yml`. Every update still runs the catalog and image workflows before review.
- [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) runs CodeQL `security-extended` queries for JavaScript/TypeScript on pull requests, `main` and weekly. Results go to the repository's code-scanning view.
- The Docker images workflow installs a pinned Trivy (v0.76.1) after `scripts/test-docker.sh` and scans all six tested images for fixed CRITICAL/HIGH vulnerabilities. The step is visible but non-blocking until findings are triaged.
- `pnpm audit --audit-level=high` in CI is part of the separate issue #15 change.

All actions stay pinned by commit SHA.

## Images

- Every `node:24-alpine` stage, and the Compose `postgres:18-alpine` and `redis:8-alpine` services, are pinned by multi-architecture index digest, alongside the tag for readability, as RustFS, aws-cli and postgres-vector already were. Dependabot proposes digest updates.
- Application files in the API, workers, web, admin and migrator runtime images are copied root-owned (no `--chown`). The unprivileged runtime user can read and execute its code but cannot rewrite it. Web and admin get a single writable `.next/cache` directory for the Next.js cache.
- API, web and admin declare a `HEALTHCHECK` that uses Node's built-in `fetch` against the local port (`/health` for the API, `/` for web, `/sign-in` for admin; these pages render without reaching the API, so an API outage does not mark the dashboards unhealthy), so no extra tools are added. A redirect counts as healthy; a 5xx or connection failure does not. Workers have no HTTP listener and the migrator is one-shot, so neither declares one.

## Behavioral image checks

[`scripts/test-docker.sh`](../scripts/test-docker.sh) keeps its existing six-image, parser, database, worker and frontend checks. Its additional [runtime permission probe](../tests/docker/runtime-hardening.mjs) runs in each of the five service images as the configured user, with networking disabled and without a read-only filesystem override. It requires a nonzero actual UID, root-owned selected application directories/files, refused directory creation and refused write-only opens of packaged entry points/configuration. Existing application bytes are never overwritten. This tests representative protected paths, not every dependency file or a fully read-only container filesystem.

Web and admin must also create, read, overwrite, rename and delete a private temporary cache entry under their actual `.next/cache`. The running API/web/admin containers must reach Docker's actual `healthy` state without replacing their configured health command or interval. The API runs on the smoke-only nondefault `PORT=3101`; existing authentication and frontend checks use that same private-network address. This would fail a health command stuck on its default port.

These health checks establish local process/HTTP liveness, not database readiness, complete worker health or RAG/provider readiness. The new behavioral assertions are written but have not yet run at this correction checkpoint. CodeQL and Trivy execution/results require their separate GitHub workflow runs; the presence of pinned workflows does not establish a clean security analysis or vulnerability-free image.

## Not included

- SBOM and provenance attestations, and cosign keyless signing, for images published to `pxdv.be`. They require deciding whether the registry stores OCI referrers and switching publication to `docker buildx --push` with `id-token: write`, which pull-request checks cannot validate.
- Secret scanning, which is a repository setting (GitHub secret scanning and push protection) rather than a workflow.
- Running Poppler as a separate uid (issue #19), which needs a privilege or deployment decision; see that issue.
