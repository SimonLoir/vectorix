import { CatalogPage } from '@/components/rag/catalog-page';
import { DocumentsManager } from '@/components/rag/documents/documents-manager';
export default function DocumentsPage() {
    return (
        <CatalogPage
            titleKey='documents.title'
            descriptionKey='documents.description'
            operation='admin.rag.documents.list'
        >
            <DocumentsManager />
        </CatalogPage>
    );
}
