import { Prisma, type PrismaClient } from '@repo/db';

/**
 * Prisma cannot express tsvector operators/ranking. Values remain parameterized;
 * the authorized publication whitelist is applied before every branch LIMIT.
 * French, English and neutral ranks are fused rather than comparing raw scores.
 */
export async function lexicalSearch(
    db: PrismaClient,
    input: {
        organizationId: string;
        generationId: string;
        publicationIds: string[];
        query: string;
        limit: number;
    }
) {
    if (!input.publicationIds.length) return [];
    return await db.$transaction(
        async (tx) => {
            await tx.$queryRaw`SELECT set_config('statement_timeout', '3000', true)`;
            const eligible = Prisma.sql`"organizationId" = ${input.organizationId}
            AND "generationId" = ${input.generationId}
            AND "indexedDocumentId" = ANY(${input.publicationIds}::text[])
            AND kind = 'CHILD'`;
            const french = Prisma.sql`websearch_to_tsquery('french', ${input.query})`;
            const english = Prisma.sql`websearch_to_tsquery('english', ${input.query})`;
            const simple = Prisma.sql`websearch_to_tsquery('simple', ${input.query})`;
            return await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
            WITH ranked AS (
                (SELECT id, row_number() OVER (ORDER BY ts_rank_cd("lexicalFrench", ${french}) DESC, id) AS r
                 FROM "Chunk" WHERE ${eligible} AND "lexicalFrench" @@ ${french}
                 ORDER BY r LIMIT ${input.limit})
                UNION ALL
                (SELECT id, row_number() OVER (ORDER BY ts_rank_cd("lexicalEnglish", ${english}) DESC, id) AS r
                 FROM "Chunk" WHERE ${eligible} AND "lexicalEnglish" @@ ${english}
                 ORDER BY r LIMIT ${input.limit})
                UNION ALL
                (SELECT id, row_number() OVER (ORDER BY ts_rank_cd("lexicalSimple", ${simple}) DESC, id) AS r
                 FROM "Chunk" WHERE ${eligible} AND "lexicalSimple" @@ ${simple}
                 ORDER BY r LIMIT ${input.limit})
            ) SELECT id FROM ranked GROUP BY id
              ORDER BY sum(1.0 / (60 + r)) DESC, id LIMIT ${input.limit}
        `);
        },
        { timeout: 5000 }
    );
}
