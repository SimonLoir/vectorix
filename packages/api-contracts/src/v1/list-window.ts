import { z } from 'zod';

/** Optional, bounded server-side windows for member and API-key lists. */
export const listWindowFields = {
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    query: z.string().trim().max(200).optional(),
};

/** New windowed calls use this size unless the caller supplies a validated limit. */
export const DEFAULT_LIST_WINDOW_LIMIT = 25;

/**
 * Preserve the complete legacy list only when no window option is supplied.
 * Even offset-only or empty-query calls opt into bounded pagination. Validation
 * belongs to listWindowFields; this helper receives the parsed contract input.
 */
export function resolveListWindow(input: {
    readonly offset?: number;
    readonly limit?: number;
    readonly query?: string;
}) {
    const windowed =
        input.offset !== undefined ||
        input.limit !== undefined ||
        input.query !== undefined;
    return {
        offset: input.offset ?? 0,
        limit: windowed
            ? (input.limit ?? DEFAULT_LIST_WINDOW_LIMIT)
            : undefined,
    };
}
