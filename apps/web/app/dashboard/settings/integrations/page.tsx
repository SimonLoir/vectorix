import { CatalogPage } from '@/components/rag/catalog-page';
import { CredentialsManager } from '@/components/rag/credentials/credentials-manager';
export default function IntegrationsPage() {
    return (
        <CatalogPage
            titleKey='credentials.title'
            descriptionKey='credentials.description'
            operation='admin.rag.credentials.list'
        >
            <CredentialsManager />
        </CatalogPage>
    );
}
