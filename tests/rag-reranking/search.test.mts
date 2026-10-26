import { after, test } from 'node:test';
import { setup, cleanup } from '../../apps/api/src/rag-tests/fixtures';
import { rerankingSearchTests } from '../../apps/api/src/rag-tests/reranking-search';

after(cleanup);
void test('Optional reranking HTTP journey with owned native providers', async (t) => {
    await setup();
    await rerankingSearchTests(t);
});
