# Local API playground and browser policy

Status: **implementation and validation in progress** for issue #54. This slice keeps the API playground available at `/` and packages its browser dependency locally. It does not change the public DTOs, API revision, authentication, trusted origins, database schema or migrations. Actual acceptance will be recorded before delivery.

## Build and deployment

`apps/api/package.json` pins `@scalar/api-reference` to `1.75.1` as a build-only devDependency. `scalar-bundle.ts` resolves the exported package entry without importing browser code, verifies the package name/version and reads its regular `dist/browser/standalone.js` file within an 8 MiB bound. The installed input is 4,627,502 bytes. Preserve its bytes, license banner and lockfile integrity when upgrading.

`apps/api/vite.config.ts` emits those bytes as `dist/scalar-api-reference.js`, enables SSR asset emission explicitly and defines the private compile constant `__VECTORIX_PACKAGED_SCALAR__`. Source development/tests resolve the installed devDependency. The compiled production branch reads only the file beside `dist/index.mjs`; it cannot fall back to an installed package or a CDN. Deployment environment variables cannot select the branch or a filesystem path.

The existing API Dockerfile copies all of `dist` and isolated production dependencies. The approximately 49.5 MB Scalar package and its transitive build dependency graph are excluded from that runtime; only the 4.6 MB standalone file is added. No new Docker asset-copy path, build tool or browser framework is needed in the runtime. The unused `vue-demi` postinstall compatibility switch is explicitly disabled in `pnpm-workspace.yaml`; copying the already built UMD does not execute Vue modules or require that switch. Frozen-lockfile installation preserves existing authentication/Next dependency resolutions rather than attaching newly introduced optional peers to those consumers.

```mermaid
flowchart LR
  Package[Exact locked build dependency] --> Bounded[Version and bounded file validation]
  Bounded --> Build[Vite SSR emits unchanged browser bytes]
  Build --> Image[API image contains index and one bundle]
  Image --> Loader[Production sibling-file loader]
  Loader --> Page[No-store HTML with fresh script nonce]
  Loader --> Asset[Content-hashed immutable JavaScript]
  Page --> Asset
  Asset --> Local[Same-origin specs and API requests]
```

## Response policy

The page has a fresh cryptographic nonce in its HTTP CSP, its two script elements and Scalar's `csp-nonce` meta hook. Executable scripts have neither an `unsafe-inline` nor an `unsafe-eval` exception. Scalar currently requires inline CSS attributes/theme styles, so `style-src` explicitly permits inline CSS. This exception does not authorize JavaScript.

The CSP starts at `default-src 'none'`; connections, fonts and ordinary images are confined to the same origin, with data images allowed. Base URLs, objects and framing are refused. HTML is `Cache-Control: no-store`, with `nosniff`, a no-referrer policy and framing protection. The favicon is local. Default web fonts, telemetry, persisted authentication, developer tools and remote agent/MCP features are disabled; no proxy or external plugin is configured. The policy intentionally prevents the playground from contacting a different API server or external spec reference.

Only the exact current `/_playground/scalar/<sha256>.js` identity is served. SHA-256/ETag and SHA-384 SRI derive from the actual served bytes. The asset has JavaScript MIME, `nosniff`, immutable caching and conditional GET support. Unknown hashes, encoded aliases and extra path segments do not become filesystem reads. Missing, oversized or changed bundle files produce a sanitized finite playground failure without exposing file paths or retargeting another origin; other API operations remain available.

Registry-derived relative specifications and current/deprecated major selection are retained. Configuration is escaped before insertion into the initialization script. No user-controlled request value chooses a file, script source, CSP nonce or API origin.

## Authentication and runtime configuration

The playground does not change fetch credentials or inject a CSRF marker. A sessionless scoped API key retains its existing issuer, membership and scope checks. If the browser also carries Cookie, unsafe requests remain subject to [cookie CSRF protection](http-cookie-csrf.md), even with a key or bearer. The API origin is not trusted implicitly: an operator who wants cookie-authenticated playground mutations must add that exact origin to `TRUSTED_ORIGINS` at startup. No production-disable flag or new environment variable is introduced.

## Entry points and planned acceptance

- `apps/api/src/api-versioning/scalar-bundle.ts`: bounded source/build and packaged runtime loaders.
- `apps/api/vite.config.ts`: build-only input, compile branch and single emitted asset.
- `apps/api/src/api-versioning/scalar.ts`: registry configuration, escaped HTML and CSP.
- `scalar-page.ts`, `scalar-asset.ts` and `scalar-icon.ts` in that directory: focused public handlers composed by `apps/api/src/app.ts`.
- `apps/api/src/scalar-playground.test.ts`: loader/admission/response regressions.
- `scripts/test-docker.sh`: deployed byte equality, CSP/cache and absence of the build dependency in the API runtime, alongside the existing six-image checks.

Automated validation passes: 68 Node tests (eight focused playground cases), 11 utility tests, 23 type-check tasks, 23 lint tasks, four production builds and 246 disposable catalog HTTP/database tests with fresh/upgrade/repeat migration and schema parity. All six images and isolated infrastructure pass the production smoke, including exact served-byte/SRI/hash/cache verification and absence of Scalar from runtime dependencies. Existing lint warnings remain. Browser prerequisites are packaged production API/web/workers and fresh owned PostgreSQL/vector/Redis/private RustFS stores with synthetic accounts and a bound scoped key. Verify local rendering, version/spec selection, search/schema expansion and a real request from the playground. With an ambient fixture Cookie and the API origin untrusted, verify the expected 403; sign out normally and verify a sessionless scoped-key request succeeds. Check warnings/errors and external dependency failures, save screenshots and exact state, then clean only owned resources. Actual browser verification is still pending.
