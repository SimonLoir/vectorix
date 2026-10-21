import { CatalogPage } from '@/components/rag/catalog-page';
import { CollectionsManager } from '@/components/rag/collections/collections-manager';
export default function CollectionsPage() {
    return (
        <CatalogPage
            title='Collections'
            description='Organisez vos profils de recherche et leurs droits d’accès.'
            operation='admin.rag.collections.list'
        >
            <CollectionsManager />
        </CatalogPage>
    );
}
