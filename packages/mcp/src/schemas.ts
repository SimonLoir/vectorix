import { z } from 'zod';
import { collectionId } from './config';

export const listInput = z
    .object({
        query: z.string().trim().max(200).default(''),
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(20).default(10),
    })
    .strict();

/** JSON-friendly subset of native filters; date strings are adapted only after tool validation. */
export const filtersInput = z
    .object({
        documentIds: z.array(collectionId).max(20).optional(),
        languages: z
            .array(z.enum(['FR', 'EN', 'MIXED', 'UNDETERMINED']))
            .max(4)
            .optional(),
        mediaTypes: z.array(z.string().min(1).max(128)).max(5).optional(),
        tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
        createdAfter: z.iso.datetime({ offset: true }).optional(),
        createdBefore: z.iso.datetime({ offset: true }).optional(),
    })
    .strict()
    .default({});

export const searchInput = z
    .object({
        collectionId,
        query: z.string().trim().min(1).max(4000),
        topK: z.number().int().min(1).max(10).default(5),
        strategy: z.enum(['HYBRID', 'LEXICAL', 'VECTOR']).default('HYBRID'),
        filters: filtersInput,
    })
    .strict();

export const sourceInput = z
    .object({
        collectionId,
        receipt: z.string().min(1).max(4096),
        before: z.number().int().min(0).max(2).default(1),
        after: z.number().int().min(0).max(2).default(1),
    })
    .strict();
