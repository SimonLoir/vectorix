import { Prisma } from '@repo/db';
import { z } from 'zod';
import { retrievalCitationMetadata } from '@repo/api-contracts/v1/retrieval';
import { indexError } from './errors';
import type { SourceLease } from './source-lease';

const projectedSourceChunk = retrievalCitationMetadata
    .pick({
        chunkId: true,
        ordinal: true,
        startOffset: true,
        endOffset: true,
        sourceSpans: true,
        sourceSpansTruncated: true,
    })
    .extend({ text: z.string().max(49_152).nullable() });
export type SourceChunk = z.infer<typeof projectedSourceChunk>;

/**
 * Same-publication CHILD neighbors only. Prisma cannot slice JSON in SELECT;
 * static parameterized SQL bounds every row's provenance before it leaves PostgreSQL.
 * Text is whole or absent; parent ordinal suffixes never become neighboring hits.
 */
export async function readSourceChunks(
    db: Prisma.TransactionClient,
    lease: SourceLease,
    input: { before: number; after: number; includeText: boolean }
): Promise<SourceChunk[]> {
    if (
        ![input.before, input.after].every(
            (n) => Number.isInteger(n) && n >= 0 && n <= 2
        )
    )
        throw indexError('CHUNK_LIMIT');
    const anchor = lease.publication.chunks[0];
    if (!anchor) throw indexError('SOURCE_UNAVAILABLE');
    const raw = await db.$queryRaw<unknown[]>(Prisma.sql`
        SELECT c."id" AS "chunkId", c."ordinal", c."startOffset", c."endOffset",
            CASE WHEN ${input.includeText} THEN c."text" ELSE NULL END AS "text",
            jsonb_path_query_array(c."sourceSpans", '$[0 to 63]') AS "sourceSpans",
            (jsonb_array_length(c."sourceSpans") > 64) AS "sourceSpansTruncated"
        FROM "Chunk" c
        WHERE c."organizationId" = ${lease.receipt.organizationId}
          AND c."generationId" = ${lease.receipt.generationId}
          AND c."indexedDocumentId" = ${lease.receipt.publicationId}
          AND c."kind" = 'CHILD'
          AND c."ordinal" BETWEEN ${Math.max(0, anchor.ordinal - input.before)}
                              AND ${anchor.ordinal + input.after}
        ORDER BY c."ordinal" ASC
        LIMIT 5
    `);
    const parsed = z.array(projectedSourceChunk).min(1).max(5).safeParse(raw);
    if (
        !parsed.success ||
        parsed.data.filter(
            (row) =>
                row.chunkId === lease.receipt.chunkId &&
                row.ordinal === anchor.ordinal
        ).length !== 1 ||
        new Set(parsed.data.map((row) => row.chunkId)).size !==
            parsed.data.length ||
        new Set(parsed.data.map((row) => row.ordinal)).size !==
            parsed.data.length ||
        (input.includeText && parsed.data.some((row) => row.text === null))
    )
        throw indexError('SOURCE_UNAVAILABLE');
    return parsed.data;
}
