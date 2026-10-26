import { ORPCError } from '@orpc/server';
import { RerankingError } from '@repo/reranking';
import { rerankFailure } from '@repo/api-contracts/v1/rag/reranking';

export type RerankFailure = typeof rerankFailure._output;
type TransportCode =
    'CONFLICT' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS' | 'FORBIDDEN';

function transportCode(errorCode: RerankFailure): TransportCode {
    if (errorCode === 'ACCESS_REVOKED') return 'FORBIDDEN';
    if (errorCode === 'RERANK_CAPACITY' || errorCode === 'RERANK_DAILY_LIMIT')
        return 'TOO_MANY_REQUESTS';
    return errorCode === 'INPUT_TOO_LARGE' ||
        errorCode === 'RERANK_INPUT_INVALID' ||
        errorCode === 'MODEL_UNSUPPORTED' ||
        errorCode === 'PROFILE_UNSUPPORTED'
        ? 'BAD_REQUEST'
        : 'CONFLICT';
}

/** Public failures contain only a finite code, never provider bodies, destinations or secrets. */
export function rerankError(
    errorCode: RerankFailure,
    code: TransportCode = transportCode(errorCode)
) {
    return new ORPCError(code, {
        message: 'The reranking operation could not be completed.',
        data: { errorCode },
    });
}

/** Rebuild trusted errors rather than forwarding arbitrary messages, data or native causes. */
export function safeRerankError(error: unknown): ORPCError<string, unknown> {
    if (error instanceof RerankingError)
        return rerankError(
            error.code === 'INVALID_CONFIGURATION'
                ? 'CREDENTIALS_INVALID'
                : error.code
        );
    if (error instanceof ORPCError) {
        const data =
            error.data &&
            typeof error.data === 'object' &&
            'errorCode' in error.data
                ? rerankFailure.safeParse(error.data.errorCode)
                : null;
        if (data?.success) return rerankError(data.data);
        if (error.code === 'BAD_REQUEST')
            return rerankError('RERANK_INPUT_INVALID');
        if (
            ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'].includes(
                String(error.code)
            )
        )
            return rerankError('ACCESS_REVOKED');
        if (error.code === 'TOO_MANY_REQUESTS')
            return rerankError('RERANK_CAPACITY');
        if (error.code === 'CONFLICT')
            return rerankError('RERANK_PROFILE_CHANGED');
    }
    return rerankError('PROCESSING_FAILED');
}
