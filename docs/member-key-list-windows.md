# Member and API-key list windows

`admin.members.get` (`GET /api/v1/admin/members`) and `admin.organization.apiKeys.list` (`GET /api/v1/admin/organization/api-keys`) accept optional server-side windows. Both changes are compatible additions in v1 revision `1.21.0`.

| Input                                           | Meaning                                                                                                                   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| No window options (`{}` or an empty REST query) | Preserve the complete legacy list, without a row cap.                                                                     |
| `limit` (1–100)                                 | Page size. Any supplied window option opts into pagination; omitting `limit` then defaults to 25 rows.                    |
| `offset` (0–100,000)                            | Rows to skip. Members are ordered by creation time ascending; keys newest first. Ties break on ID.                        |
| `query` (up to 200 characters)                  | Case-insensitive match on member name or email, or on API-key name. Even an empty supplied query requests a bounded page. |

Both outputs add `total`, the number of matches in the caller's organization. Existing clients that send no window options keep the complete result they previously received, including lists larger than 1,000 rows. This legacy exception preserves the supported v1 contract; new consumers should always request a window. Offset-only and query-only calls default to 25 rows rather than accidentally returning an unbounded filtered list.

Queries remain scoped to the authenticated organization. Permission checks, suspension handling and API-key listing's session-only restriction are unchanged. The [contract helper](../packages/api-contracts/src/v1/list-window.ts) distinguishes legacy and windowed calls after validation. The [member](../packages/routers/members/src/private/get-members.ts) and [API-key](../packages/routers/organizations/src/api-keys/list-api-keys.ts) handlers run their list and matching count in one transaction and project safe metadata rather than API-key secrets.

## Dashboard

The members page (`/dashboard/settings/members`) and API-key page (`/dashboard/account/api-keys`) always request 25 rows, with localized search and pagination controls in English, French and Belgian Dutch. They show loading on every page, separate empty search/page states, and finite error/retry states. A failed member read hides cached member rows. Previous-page navigation remains available when a mutation leaves the current page empty.

Members without `member:read` retain Better Auth's existing filtered organization view. Native organization/session changes recreate the dashboard query scope. Confirmed member removal now refreshes all TanStack query variants, matching role updates and API-key mutations, so cached pages and searches do not keep removed members.

## Verification

[`list-windows.ts`](../apps/api/src/rag-tests/list-windows.ts) covers organization-scoped windows, stable order, case-insensitive search, foreign organizations, REST query coercion and API-key name search. [`list-window-compatibility.ts`](../apps/api/src/rag-tests/list-window-compatibility.ts) adds 1,005 ordinary member fixtures and 1,005 disabled synthetic key records in the disposable `_test` database. It exercises both real RPC and REST handlers above the former truncation threshold, implicit 25-row windows, the 100-row maximum and invalid input rejection. Fixture writes are test metadata only: no mass account sign-up, usable credential, role promotion or external provider call. Cleanup is scoped to the created IDs and organization in `finally`.

The review correction passes frozen installation, ignored-client generation, 24 type checks, 24 lint tasks and 159 API/backend plus 11 utility tests. A focused table extraction removes the added member-manager complexity warning; final web types/lint pass again. The existing worktree admin declaration is restored byte-for-byte with its original mode, and the initially absent web declaration remains absent. The new disposable integration case has not yet run. Catalog, production builds/images and actual browser pagination remain pending.

For dashboard acceptance in a synthetic instance with more than 25 rows, sign in normally with the relevant list permissions. Open each table, use Next/Previous, search a known name (or member email), and confirm the count and empty-search state. Reload and switch organizations to confirm the results stay scoped. Credential creation, role changes and member/key deletion remain automated test actions; this recipe needs no such browser action. No browser result is claimed yet.

The compatible list additions use revision `1.21.0` after the separate request-budget addition in `1.20.0`. The global release metadata and supported-major header/spec assertions advance together; neither change replaces the v1 contract or truncates legacy unwindowed reads.

The local integration with the reviewed PR78 candidate `733a0f1f3464899d23ff146f4a8bffb124d83dcc` passes a new frozen installation/generation, all 24 workspace type and lint tasks and the uncached unit suite (10 discovery, 189 API/backend, 56 chunking, 146 embedding and 11 utility tests). Both Next declarations are restored to the actual pre-pass bytes, modes and absence. The list workflow implementation remains unchanged except for the global compatible revision and its eight existing spec/header assertions; inherited rate-limit translations are preserved. The earlier 319-test catalog and four-build pass belongs to the separate correction tree. A combined catalog/build and actual browser run remain pending; no earlier result is relabeled.
