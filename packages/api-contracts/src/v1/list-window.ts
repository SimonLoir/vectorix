import { z } from 'zod';

/**
 * Optional server-side window for member and API-key lists. Omitting `limit`
 * keeps the original full-list response for existing clients, capped at
 * LEGACY_LIST_LIMIT rows; `total` always reports the full match count.
 */
export const listWindowFields = {
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    query: z.string().trim().max(200).optional(),
};

/** Upper bound for clients that do not request a window. */
export const LEGACY_LIST_LIMIT = 1000;
