import { Prisma } from '@repo/db';
import { z } from 'zod';
import {
    chunkView,
    parentContext,
} from '@repo/api-contracts/v1/rag/indexing-types';
import { indexError } from './errors';

const projectedChunk = chunkView
    .pick({
        id: true,
        generationId: true,
        ordinal: true,
        text: true,
        tokenCount: true,
        tokenCountIsEstimate: true,
        language: true,
        sourceSpans: true,
        sourceSpansTruncated: true,
    })
    .extend({
        indexedDocumentId: z.string().min(1).max(191),
        startOffset: z.number().int().nonnegative().nullable(),
        endOffset: z.number().int().nonnegative().nullable(),
        parentContext: parentContext.nullable(),
    });

export type ProjectedChunk = z.infer<typeof projectedChunk>;

/**
 * Hydrate at most 100 already-authorized representative children. Prisma cannot
 * slice a JSON array in SELECT, so static parameterized SQL projects provenance
 * before crossing the database boundary, including for a large parent artifact.
 * Callers must recheck current publication/association and collection access.
 */
export async function readProjectedChunks(
    db: Prisma.TransactionClient,
    input: {
        organizationId: string;
        generationId: string;
        ids: string[];
        parentEnabled: boolean;
    }
) {
    if (!input.ids.length) return [];
    if (input.ids.length > 100 || new Set(input.ids).size !== input.ids.length)
        throw indexError('CHUNK_LIMIT');
    const raw = await db.$queryRaw<unknown[]>(Prisma.sql`
        SELECT c."id", c."generationId", c."indexedDocumentId", c."ordinal",
               c."text", c."tokenCount", c."tokenCountIsEstimate", c."language",
               c."startOffset", c."endOffset",
               jsonb_path_query_array(c."sourceSpans", '$[0 to 63]') AS "sourceSpans",
               (jsonb_array_length(c."sourceSpans") > 64) AS "sourceSpansTruncated",
               CASE WHEN p."id" IS NULL THEN NULL ELSE jsonb_build_object(
                   'id', p."id", 'ordinal', p."ordinal", 'text', p."text",
                   'startOffset', p."startOffset", 'endOffset', p."endOffset",
                   'tokenCount', p."tokenCount", 'tokenCountIsEstimate', p."tokenCountIsEstimate",
                   'sourceSpans', jsonb_path_query_array(p."sourceSpans", '$[0 to 63]'),
                   'sourceSpansTruncated', jsonb_array_length(p."sourceSpans") > 64
               ) END AS "parentContext"
        FROM "Chunk" c
        LEFT JOIN "Chunk" p ON p."id" = c."parentId"
            AND p."organizationId" = c."organizationId"
            AND p."generationId" = c."generationId"
            AND p."indexedDocumentId" = c."indexedDocumentId"
            AND p."kind" = 'PARENT'
        WHERE c."organizationId" = ${input.organizationId}
          AND c."generationId" = ${input.generationId}
          AND c."kind" = 'CHILD'
          AND c."id" IN (${Prisma.join(input.ids)})
        LIMIT 100
    `);
    const parsed = z.array(projectedChunk).max(100).safeParse(raw);
    if (!parsed.success) throw indexError('SOURCE_UNAVAILABLE');
    for (const row of parsed.data) {
        const parent = row.parentContext;
        if (
            input.parentEnabled
                ? !parent ||
                  row.startOffset === null ||
                  row.endOffset === null ||
                  parent.startOffset > row.startOffset ||
                  row.startOffset >= row.endOffset ||
                  row.endOffset > parent.endOffset
                : parent !== null
        )
            throw indexError('SOURCE_UNAVAILABLE');
    }
    return parsed.data;
}
