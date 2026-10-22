import { ORPCError } from '@orpc/server';
import { z } from 'zod';
import {
    documentMetadata,
    metadataFields,
} from '@repo/api-contracts/v1/rag/indexing-types';

const timestamp = z.iso.datetime({ offset: true });

/** Canonical UTC values keep typed metadata equality/ranges independent of the original timezone spelling. */
export function canonicalMetadataDate(value: unknown): string {
    const parsed = timestamp.safeParse(value);
    if (!parsed.success)
        throw new ORPCError('BAD_REQUEST', {
            message:
                'Use a valid ISO timestamp with an explicit timezone for date metadata.',
        });
    return new Date(parsed.data).toISOString();
}

/** Declared collection fields are the allowlist; unknown keys and incompatible scalar values fail closed. */
export function validateMetadata(fieldsValue: unknown, valuesValue: unknown) {
    const fields = metadataFields.parse(fieldsValue);
    const values = documentMetadata.parse(valuesValue);
    const normalized: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(values)) {
        const kind = fields[key];
        if (kind === 'DATE') normalized[key] = canonicalMetadataDate(value);
        else if (
            (kind === 'STRING' && typeof value === 'string') ||
            (kind === 'NUMBER' &&
                typeof value === 'number' &&
                Number.isFinite(value)) ||
            (kind === 'BOOLEAN' && typeof value === 'boolean')
        )
            normalized[key] = value;
        else
            throw new ORPCError('BAD_REQUEST', {
                message:
                    'Document metadata must match the collection’s declared field types.',
            });
    }
    return normalized;
}
