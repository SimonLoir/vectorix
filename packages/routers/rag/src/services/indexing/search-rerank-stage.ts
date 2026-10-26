import type { AuthorizedContext } from '@routers/utils/authorized';
import type { Prisma } from '@repo/db';
import { requireIndexRead } from './access';
import { indexError } from './errors';
import {
    applyRerankScores,
    readRerankChildren,
    remainingSearchMs,
    rerankCandidateIds,
    unchangedRerankChildren,
    type SearchChildMetadata,
} from './search-reranking';
import type { SearchRanking, SearchReranking } from './search-types';

/**
 * Hydrate only authorized children for the opt-in provider stage, then refresh
 * exact publication/text identity. Final parent/source projection happens later.
 */
export async function rankSearchChildren(
    context: AuthorizedContext,
    input: {
        organizationId: string;
        collectionId: string;
        generationId: string;
        ranked: SearchRanking;
        metadata: SearchChildMetadata[];
        parentEnabled: boolean;
        publications: () => Prisma.IndexedDocumentWhereInput;
        reranking: SearchReranking;
    }
) {
    const { reranking } = input;
    const ids = rerankCandidateIds(
        input.ranked,
        input.metadata,
        reranking.candidateLimit,
        input.parentEnabled
    );
    const readChildren = () =>
        readRerankChildren(context.db, {
            organizationId: input.organizationId,
            generationId: input.generationId,
            ids,
            publications: input.publications(),
        });
    const children = await readChildren();
    const byId = new Map(children.map((child) => [child.id, child]));
    const candidates = ids.flatMap((id) => {
        const child = byId.get(id);
        return child ? [child] : [];
    });
    const nativeScores = await reranking.rank({
        candidates,
        remainingMs: () => remainingSearchMs(reranking.startedAt),
        assertCurrent: async () => {
            await requireIndexRead(context, input.collectionId);
            if (
                unchangedRerankChildren(candidates, await readChildren())
                    .length !== candidates.length
            )
                throw indexError('SOURCE_UNAVAILABLE');
            remainingSearchMs(reranking.startedAt);
        },
    });
    const scored = applyRerankScores(candidates, nativeScores, input.ranked);
    await requireIndexRead(context, input.collectionId);
    return {
        ...scored,
        eligible: unchangedRerankChildren(candidates, await readChildren()),
        candidateCount: candidates.length,
    };
}
