import { z } from 'zod';
import { searchFilters } from '@repo/api-contracts/v1/rag/indexing-types';
import { typedMetadataValue } from './document-metadata';
import type { MetadataFields } from './types';

const metadataRows = z
    .array(
        z.object({
            field: z.string(),
            operator: z.enum(['EQ', 'IN', 'GTE', 'LTE']),
            value: z.string(),
        })
    )
    .max(20);
/** Parse only filters declared by the currently serving profile. */
export function filtersFromForm(data: FormData, fields: MetadataFields) {
    const list = (key: string) => data.getAll(key).map(String);
    const rows = metadataRows.parse(
        JSON.parse(String(data.get('metadataFilters') ?? '[]'))
    );
    const metadata = rows.map((row) => {
        const type = fields[row.field];
        if (!type) throw new Error('Invalid filter.');
        return {
            field: row.field,
            operator: row.operator,
            value:
                row.operator === 'IN'
                    ? row.value
                          .split('\n')
                          .map((value) =>
                              typedMetadataValue(value.trim(), type)
                          )
                    : typedMetadataValue(row.value.trim(), type),
        };
    });
    const documentIds = z
        .array(z.string())
        .parse(JSON.parse(String(data.get('documentIds') ?? '[]')));
    const after = String(data.get('createdAfter') ?? '');
    const before = String(data.get('createdBefore') ?? '');
    return searchFilters.parse({
        ...(documentIds.length ? { documentIds } : {}),
        ...(list('language').length ? { languages: list('language') } : {}),
        ...(list('mediaType').length ? { mediaTypes: list('mediaType') } : {}),
        ...(String(data.get('tags') ?? '').trim()
            ? {
                  tags: String(data.get('tags'))
                      .split(',')
                      .map((tag) => tag.trim())
                      .filter(Boolean),
              }
            : {}),
        ...(after ? { createdAfter: new Date(`${after}T00:00:00.000Z`) } : {}),
        ...(before
            ? { createdBefore: new Date(`${before}T23:59:59.999Z`) }
            : {}),
        ...(metadata.length ? { metadata } : {}),
    });
}
