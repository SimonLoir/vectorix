import { ORPCError } from '@orpc/server';
import { EmbeddingError } from '@repo/embeddings';
import { VectorStoreError } from '@repo/vector-store';
import { indexFailure } from '@repo/api-contracts/v1/rag/indexing-types';

export type IndexFailure = typeof indexFailure._output;

/** Stable, localizable domain codes only; provider bodies and private destinations never escape. */
export function indexError(
    errorCode: IndexFailure,
    code:
        | 'CONFLICT'
        | 'BAD_REQUEST'
        | 'SERVICE_UNAVAILABLE'
        | 'FORBIDDEN' = 'CONFLICT'
) {
    return new ORPCError(code, {
        message: 'The indexing operation could not be completed.',
        data: { errorCode },
    });
}

/** Translate integration failures at the API boundary without retaining raw diagnostics. */
export function safeIndexError(error: unknown): ORPCError<string, unknown> {
    if (error instanceof ORPCError) return error;
    if (error instanceof EmbeddingError)
        return indexError(
            error.code === 'INVALID_CONFIGURATION'
                ? 'CREDENTIALS_INVALID'
                : error.code
        );
    if (error instanceof VectorStoreError)
        return indexError(
            error.code === 'DESTINATION_DRIFT'
                ? 'VECTOR_BINDING_CHANGED'
                : 'VECTOR_UNAVAILABLE'
        );
    return indexError('PROCESSING_FAILED');
}

/** Old/new worker codes are narrowed explicitly before entering a public enum. */
export function publicIndexFailure(value: string | null) {
    if (!value) return null;
    const parsed = indexFailure.safeParse(value);
    return parsed.success ? parsed.data : ('PROCESSING_FAILED' as const);
}
