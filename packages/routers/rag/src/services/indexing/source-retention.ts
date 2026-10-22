export const SOURCE_RECEIPT_TTL_MS = 15 * 60_000;
export const SOURCE_IO_ALLOWANCE_MS = 60_000;
export const SEARCH_DEADLINE_MS = 60_000;
/** A search captured before retirement can finish and issue its full bounded source receipt. */
export const SOURCE_RETIRE_GRACE_MS =
    SEARCH_DEADLINE_MS + SOURCE_RECEIPT_TTL_MS + SOURCE_IO_ALLOWANCE_MS;
