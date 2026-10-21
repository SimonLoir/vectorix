import { CatalogPage } from '@/components/rag/catalog-page';
import { CollectionsManager } from '@/components/rag/collections/collections-manager';
export default function CollectionsPage() {
    return (
        <CatalogPage
            titleKey='collections.title'
            descriptionKey='collections.description'
            operation='admin.rag.collections.list'
        >
            <CollectionsManager />
        </CatalogPage>
    );
}
