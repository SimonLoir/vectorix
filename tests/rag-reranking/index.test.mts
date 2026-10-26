import { after, test } from 'node:test';
import { setup, cleanup } from '../../apps/api/src/rag-tests/fixtures';
import { rerankingAccountingTests } from './accounting.mjs';

// The catalog runner already owns the only accepted loopback _test database.
// This process retains the existing native-auth fixture and connection cleanup.
after(cleanup);
void test('Reranking mandatory accounting with real PostgreSQL and owned native HTTP', async (t) => {
    await setup();
    await rerankingAccountingTests(t);
});
