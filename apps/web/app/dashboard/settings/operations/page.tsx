import { CatalogPage } from '@/components/rag/catalog-page';
import { OperationsOverview } from '@/components/rag/operations/operations-overview';

export default function OperationsPage() {
    return (
        <CatalogPage
            titleKey='operations.title'
            descriptionKey='operations.description'
            operation='admin.rag.operations.overview'
        >
            <OperationsOverview />
        </CatalogPage>
    );
}
