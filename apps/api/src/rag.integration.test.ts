import { after, test } from 'node:test';
import { setup, cleanup } from './rag-tests/fixtures';
import { credentialTests } from './rag-tests/credentials';
import { embeddingProviderTests } from './rag-tests/embedding-providers';
import { accessTests } from './rag-tests/access';
import { dashboardTests } from './rag-tests/dashboard';
import { documentLibraryTests } from './rag-tests/document-library';
import { documentLifecycleTests } from './rag-tests/document-lifecycle';
import { documentRetentionTests } from './rag-tests/document-retention';
import { lifecycleTests } from './rag-tests/lifecycle';

after(cleanup);
void test('RAG catalog with real PostgreSQL and HTTP transports', async (t) => {
    await setup();
    await credentialTests(t);
    await embeddingProviderTests(t);
    await accessTests(t);
    await dashboardTests(t);
    await lifecycleTests(t);
    await documentLibraryTests(t);
    await documentLifecycleTests(t);
    await documentRetentionTests(t);
});
