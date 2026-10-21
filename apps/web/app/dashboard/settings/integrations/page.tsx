import { CatalogPage } from '@/components/rag/catalog-page';
import { CredentialsManager } from '@/components/rag/credentials/credentials-manager';
export default function IntegrationsPage() {
    return (
        <CatalogPage
            title='Intégrations'
            description='Configurez le stockage et les fournisseurs d’embeddings de votre organisation.'
            operation='admin.rag.credentials.list'
        >
            <CredentialsManager />
        </CatalogPage>
    );
}
