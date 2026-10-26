import { rerankPolicyValues } from '@repo/api-contracts/v1/rag/reranking';
import { rerankError } from './errors';

/** Operator technical limits are independent of commercial entitlements and never silently coerce malformed values. */
export function rerankLimits() {
    const parsed = rerankPolicyValues.safeParse({
        requestsPerDay: Number(
            process.env.VECTORIX_DEFAULT_RAG_RERANK_REQUESTS_PER_DAY ?? 500
        ),
        preparedBytesPerDay: Number(
            process.env.VECTORIX_DEFAULT_RAG_RERANK_PREPARED_BYTES_PER_DAY ??
                268_435_456
        ),
        concurrentRequests: Number(
            process.env.VECTORIX_DEFAULT_RAG_RERANK_CONCURRENT_REQUESTS ?? 4
        ),
    });
    if (!parsed.success) throw rerankError('RERANK_CAPACITY');
    return parsed.data;
}

/** Daily limits follow UTC dispatch intent, including uncertain provider outcomes. */
export function utcDay(now = new Date()) {
    return new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
}
