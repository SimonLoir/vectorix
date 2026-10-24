# Bounded member and API-key lists

This page covers issue #26. `admin.members.get` (`GET /api/v1/admin/members`) and `admin.organization.apiKeys.list` (`GET /api/v1/admin/organization/api-keys`) used to return every row. They now accept an optional server-side window. Both changes are compatible additions in v1 revision `1.20.0`.

| Input                          | Meaning                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| `limit` (1–100)                | Page size. When omitted, the response keeps its original full-list shape, capped at 1,000 rows.    |
| `offset` (0–100,000)           | Rows to skip. Members are ordered by creation time ascending; keys newest first. Ties break on ID. |
| `query` (up to 200 characters) | Case-insensitive match on member name or email, or on API-key name.                                |

Both outputs add `total`, the number of matches in the caller's organization. Callers can therefore detect when a legacy call without `limit` reached the 1,000-row cap. Queries stay scoped to the authenticated organization, and existing permission and session-only checks are unchanged. The [contract helper](../packages/api-contracts/src/v1/list-window.ts) defines the inputs, and the [members](../packages/routers/members/src/private/get-members.ts) and [API-key](../packages/routers/organizations/src/api-keys/list-api-keys.ts) handlers run `findMany` and `count` in one transaction.

## Dashboard

The members page (`/dashboard/settings/members`) and API-key page (`/dashboard/account/api-keys`) request 25 rows at a time, with a localized search field (EN/FR/nl-BE) and the shared catalog pagination controls. Members without `member:read` keep Better Auth's own filtered organization view, as before. Every member or key mutation already invalidates all queries, so each page and search variant refreshes.

## Verification

[`apps/api/src/rag-tests/list-windows.ts`](../apps/api/src/rag-tests/list-windows.ts) covers the legacy shape, windows and stable order, case-insensitive search, cross-organization isolation, REST query coercion, the `limit` upper bound and API-key name search.
