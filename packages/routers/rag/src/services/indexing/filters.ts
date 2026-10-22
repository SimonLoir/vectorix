import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import {
    metadataFields,
    searchFilters,
} from '@repo/api-contracts/v1/rag/indexing-types';
import { canonicalMetadataDate } from './metadata-validation';

export type SearchFilters = typeof searchFilters._output;

/** Validate typed filter operators before constructing ORM predicates; all dates compare as canonical UTC strings. */
export function publicationFilters(
    fieldsValue: unknown,
    filters: SearchFilters
): Prisma.IndexedDocumentWhereInput {
    const fields = metadataFields.parse(fieldsValue);
    const invalid = () =>
        new ORPCError('BAD_REQUEST', {
            message:
                'Search filters must match the collection field declarations.',
        });
    if (
        filters.createdAfter &&
        filters.createdBefore &&
        filters.createdAfter > filters.createdBefore
    )
        throw invalid();
    const conditions: Prisma.IndexedDocumentWhereInput[] = [];
    for (const condition of filters.metadata ?? []) {
        const kind = fields[condition.field];
        const normalize = (value: string | number | boolean) => {
            if (kind === 'STRING' && typeof value === 'string') return value;
            if (
                kind === 'NUMBER' &&
                typeof value === 'number' &&
                Number.isFinite(value)
            )
                return value;
            if (kind === 'BOOLEAN' && typeof value === 'boolean') return value;
            if (kind === 'DATE') return canonicalMetadataDate(value);
            throw invalid();
        };
        const equals = (
            value: string | number | boolean
        ): Prisma.IndexedDocumentWhereInput => ({
            metadata: { path: [condition.field], equals: normalize(value) },
        });
        if (condition.operator === 'EQ')
            conditions.push(equals(condition.value));
        else if (condition.operator === 'IN')
            conditions.push({ OR: condition.value.map(equals) });
        else {
            if (kind !== 'NUMBER' && kind !== 'DATE') throw invalid();
            const value = normalize(condition.value);
            conditions.push({
                metadata: {
                    path: [condition.field],
                    ...(condition.operator === 'GTE'
                        ? { gte: value }
                        : { lte: value }),
                },
            });
        }
    }
    return {
        ...(filters.documentIds
            ? { documentId: { in: [...new Set(filters.documentIds)] } }
            : {}),
        ...(filters.languages ? { language: { in: filters.languages } } : {}),
        ...(filters.mediaTypes
            ? { mediaType: { in: filters.mediaTypes } }
            : {}),
        ...(filters.tags?.length ? { tags: { hasEvery: filters.tags } } : {}),
        ...(filters.createdAfter || filters.createdBefore
            ? {
                  documentCreatedAt: {
                      ...(filters.createdAfter
                          ? { gte: filters.createdAfter }
                          : {}),
                      ...(filters.createdBefore
                          ? { lte: filters.createdBefore }
                          : {}),
                  },
              }
            : {}),
        ...(conditions.length ? { AND: conditions } : {}),
    };
}
