import { CatalogPage } from '@/components/rag/catalog-page';
import { IntegrationsTabs } from '@/components/rag/credentials/integrations-tabs';
export default function IntegrationsPage() {
    return (
        <CatalogPage
            titleKey='credentials.title'
            descriptionKey='credentials.description'
            operation='admin.rag.credentials.list'
        >
            <IntegrationsTabs />
        </CatalogPage>
    );
}
