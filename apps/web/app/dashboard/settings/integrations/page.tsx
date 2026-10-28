import { CatalogPage } from '@/components/rag/catalog-page';
import { IntegrationsTabs } from '@/components/rag/credentials/integrations-tabs';
export default function IntegrationsPage() {
    return (
        <CatalogPage
            titleKey='credentials.title'
            descriptionKey='clients.pageDescription'
            operation={['admin.rag.credentials.list', 'retrieval.search']}
        >
            <IntegrationsTabs />
        </CatalogPage>
    );
}
