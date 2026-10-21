import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { quotaValues } from '@repo/api-contracts/v1/rag/index';

const defaults = {
    collections: 20,
    documents: 5000,
    originalBytes: 25 * 1024 * 1024,
    storageBytes: 10 * 1024 ** 3,
    chunksPerCollection: 100_000,
};
const names = {
    collections: 'COLLECTIONS',
    documents: 'DOCUMENTS',
    originalBytes: 'ORIGINAL_BYTES',
    storageBytes: 'STORAGE_BYTES',
    chunksPerCollection: 'CHUNKS_PER_COLLECTION',
} as const;
/** Per-organization overrides replace deployment defaults; invalid limits fail closed. */
export async function quotaLimits(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const stored = await db.organizationQuota.findUnique({
        where: { organizationId },
    });
    const values = stored
        ? {
              collections: stored.collections,
              documents: stored.documents,
              chunksPerCollection: stored.chunksPerCollection,
              originalBytes: Number(stored.originalBytes),
              storageBytes: Number(stored.storageBytes),
          }
        : Object.fromEntries(
              Object.entries(defaults).map(([key, fallback]) => [
                  key,
                  process.env[
                      `VECTORIX_DEFAULT_RAG_${names[key as keyof typeof names]}`
                  ] === undefined
                      ? fallback
                      : Number(
                            process.env[
                                `VECTORIX_DEFAULT_RAG_${names[key as keyof typeof names]}`
                            ]
                        ),
              ])
          );
    const parsed = quotaValues.safeParse(values);
    if (!parsed.success)
        throw new ORPCError('CONFLICT', {
            message: 'Organization quota configuration is invalid.',
        });
    return parsed.data;
}
export async function quotaUsage(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const [collections, documents, originals, extractions] = await Promise.all([
        db.collection.count({ where: { organizationId, deletedAt: null } }),
        db.document.count({ where: { organizationId, deletedAt: null } }),
        db.documentVersion.aggregate({
            where: { organizationId },
            _sum: { byteSize: true },
        }),
        db.documentExtraction.aggregate({
            where: { organizationId },
            _sum: { byteSize: true },
        }),
    ]);
    return {
        collections,
        documents,
        storageBytes: Number(
            (originals._sum.byteSize ?? 0n) + (extractions._sum.byteSize ?? 0n)
        ),
    };
}
