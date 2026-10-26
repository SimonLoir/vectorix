import type { Prisma } from '@repo/db';
import { indexError } from './errors';
import type { SearchChild, SearchRanking } from './search-types';
import { SEARCH_DEADLINE_MS } from './source-retention';

export type SearchChildMetadata = Omit<SearchChild, 'text'>;

/** Select a bounded RRF child pool without prematurely discarding siblings of the same parent. */
export function rerankCandidateIds(
    ranked: SearchRanking,
    metadata: readonly SearchChildMetadata[],
    limit: number,
    parentEnabled: boolean
) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        throw indexError('INPUT_TOO_LARGE', 'BAD_REQUEST');
    const eligible = new Map(metadata.map((child) => [child.id, child]));
    return ranked
        .filter(([id]) => {
            const child = eligible.get(id);
            if (!child) return false;
            if (parentEnabled !== (child.parentId !== null))
                throw indexError('SOURCE_UNAVAILABLE');
            return true;
        })
        .slice(0, limit)
        .map(([id]) => id);
}

/** Scalar child text only: parent text and complete source JSON never enter the provider candidate pool. */
export function readRerankChildren(
    db: Prisma.TransactionClient,
    input: {
        organizationId: string;
        generationId: string;
        ids: readonly string[];
        publications: Prisma.IndexedDocumentWhereInput;
    }
): Promise<SearchChild[]> {
    if (input.ids.length > 100 || new Set(input.ids).size !== input.ids.length)
        throw indexError('CHUNK_LIMIT');
    if (!input.ids.length) return Promise.resolve([]);
    return db.chunk.findMany({
        where: {
            organizationId: input.organizationId,
            generationId: input.generationId,
            kind: 'CHILD',
            id: { in: [...input.ids] },
            indexedDocument: input.publications,
        },
        select: {
            id: true,
            indexedDocumentId: true,
            parentId: true,
            text: true,
        },
        take: input.ids.length,
    });
}

/** Keep the captured canonical identity and text; a changed association or body cannot inherit an old score. */
export function unchangedRerankChildren(
    captured: readonly SearchChild[],
    current: readonly SearchChild[]
) {
    const eligible = new Map(current.map((child) => [child.id, child]));
    return captured.filter((child) => {
        const observed = eligible.get(child.id);
        return (
            observed &&
            observed.indexedDocumentId === child.indexedDocumentId &&
            observed.parentId === child.parentId &&
            observed.text === child.text
        );
    });
}

/** Validate a complete indexed permutation before associating native scores with canonical child IDs. */
export function applyRerankScores(
    candidates: readonly SearchChild[],
    response: readonly { index: number; score: number }[],
    ranked: SearchRanking
) {
    if (response.length !== candidates.length)
        throw indexError('INVALID_PROVIDER_RESPONSE', 'SERVICE_UNAVAILABLE');
    const scores = new Map<string, number>();
    for (const row of response) {
        if (
            !Number.isInteger(row.index) ||
            row.index < 0 ||
            row.index >= candidates.length ||
            !Number.isFinite(row.score) ||
            row.score < 0 ||
            row.score > 1
        )
            throw indexError(
                'INVALID_PROVIDER_RESPONSE',
                'SERVICE_UNAVAILABLE'
            );
        const child = candidates[row.index]!;
        if (scores.has(child.id))
            throw indexError(
                'INVALID_PROVIDER_RESPONSE',
                'SERVICE_UNAVAILABLE'
            );
        scores.set(child.id, row.score);
    }
    const ordered = ranked
        .filter(([id]) => scores.has(id))
        .toSorted(
            ([leftId, left], [rightId, right]) =>
                scores.get(rightId)! - scores.get(leftId)! ||
                right.rrf - left.rrf ||
                leftId.localeCompare(rightId)
        );
    if (ordered.length !== candidates.length)
        throw indexError('SOURCE_UNAVAILABLE');
    return { ranked: ordered, scores };
}

/** Final baseline and reranked projections share one bounded set of canonical context/source rows. */
export function searchProjectionIds(...orders: readonly SearchRanking[]) {
    const ids = [
        ...new Set(orders.flatMap((order) => order.map(([id]) => id))),
    ];
    if (ids.length > 100) throw indexError('CHUNK_LIMIT');
    return ids;
}

/** Reranking consumes the original search deadline, including claim admission and retrieval. */
export function remainingSearchMs(startedAt: number, now = Date.now()) {
    const remaining = SEARCH_DEADLINE_MS - (now - startedAt);
    if (
        !Number.isFinite(remaining) ||
        remaining <= 0 ||
        remaining > SEARCH_DEADLINE_MS
    )
        throw indexError('PROVIDER_TIMEOUT', 'SERVICE_UNAVAILABLE');
    return remaining;
}
