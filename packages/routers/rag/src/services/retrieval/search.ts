import type { AuthorizedContext } from '@routers/utils/authorized';
import { searchCollection } from '../indexing/search';
import type { SearchInput } from '../indexing/search-types';

/** The external endpoint preserves ordinary retrieval semantics and never silently opts into reranking. */
export function searchRetrieval(
    context: AuthorizedContext,
    input: SearchInput
) {
    return searchCollection(context, input);
}
