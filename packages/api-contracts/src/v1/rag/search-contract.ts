import { z } from 'zod';
import { id } from './common';
import { searchFilters, searchResult } from './indexing-types';

/** Stable ordinary-search DTOs shared by the separate opt-in reranking operation. */
export const searchInput = z
    .object({
        collectionId: id,
        query: z.string().trim().min(1).max(4000),
        topK: z.number().int().min(1).max(50).default(10),
        strategy: z.enum(['HYBRID', 'LEXICAL', 'VECTOR']).default('HYBRID'),
        filters: searchFilters,
    })
    .strict();
export const searchOutput = z.object({
    generationId: id,
    model: z.string(),
    strategy: z.enum(['HYBRID', 'LEXICAL', 'VECTOR']),
    results: z.array(searchResult).max(50),
    vectorUnderfilled: z.boolean(),
    parentUnderfilled: z
        .boolean()
        .describe(
            'The bounded child candidate window yielded fewer distinct parents than requested; this does not establish corpus exhaustion.'
        )
        .optional(),
    durationMs: z.number().nonnegative(),
});
