import { authorized } from '@routers/utils/authorized';
import { searchRetrievalHandler } from './search';
import { citationRetrievalHandler } from './citation';
import { contextRetrievalHandler } from './context';
export const retrievalRouter = authorized
    .prefix('/retrieval')
    .tag('Retrieval')
    .router({
        search: searchRetrievalHandler,
        citation: citationRetrievalHandler,
        context: contextRetrievalHandler,
    });
