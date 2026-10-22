import type { Prisma } from '@repo/db';
import { metadataFields } from '@repo/api-contracts/v1/rag/indexing-types';
import { projectMetadata } from './metadata-validation';
import { indexError } from './errors';
import { MAX_INDEXED_DOCUMENTS_PER_COLLECTION } from './limits';

/** Validate a draft declaration without silently retyping metadata used by a still-retained generation. */
export async function validateProfileMetadata(
    tx: Prisma.TransactionClient,
    organizationId: string,
    collectionId: string,
    fieldsValue: unknown
) {
    const next = metadataFields.parse(fieldsValue);
    const generations = await tx.indexGeneration.findMany({
        where: { organizationId, collectionId, status: { not: 'CLEANED' } },
        select: { configuration: { select: { metadataFields: true } } },
        take: 3,
    });
    if (generations.length > 2)
        throw indexError('GENERATION_CONFLICT', 'CONFLICT');
    for (const generation of generations) {
        const previous = metadataFields.parse(
            generation.configuration.metadataFields
        );
        if (
            Object.entries(next).some(
                ([key, kind]) => previous[key] && previous[key] !== kind
            )
        )
            throw indexError('METADATA_INCOMPATIBLE', 'CONFLICT');
    }
    // A key restored after all old generations were cleaned can still have old
    // association values. Validate those values in bounded batches, never loading
    // an entire maximum-size metadata library into one process allocation.
    let cursor: string | undefined;
    let inspected = 0;
    for (;;) {
        const rows = await tx.collectionDocument.findMany({
            where: {
                organizationId,
                collectionId,
                document: { deletedAt: null },
            },
            orderBy: { documentId: 'asc' },
            take: 100,
            ...(cursor
                ? {
                      cursor: {
                          ['collectionId_documentId']: {
                              collectionId,
                              documentId: cursor,
                          },
                      },
                      skip: 1,
                  }
                : {}),
            select: { documentId: true, metadata: true },
        });
        inspected += rows.length;
        if (inspected > MAX_INDEXED_DOCUMENTS_PER_COLLECTION)
            throw indexError('CHUNK_LIMIT', 'CONFLICT');
        for (const row of rows) {
            try {
                projectMetadata(next, row.metadata);
            } catch {
                throw indexError('METADATA_INCOMPATIBLE', 'CONFLICT');
            }
        }
        if (rows.length < 100) return;
        cursor = rows.at(-1)!.documentId;
    }
}
