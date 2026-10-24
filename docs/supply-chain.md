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

## Not included

- SBOM and provenance attestations, and cosign keyless signing, for images published to `pxdv.be`. They require deciding whether the registry stores OCI referrers and switching publication to `docker buildx --push` with `id-token: write`, which pull-request checks cannot validate.
- Secret scanning, which is a repository setting (GitHub secret scanning and push protection) rather than a workflow.
- Running Poppler as a separate uid (issue #19), which needs a privilege or deployment decision; see that issue.
