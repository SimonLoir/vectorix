import { CatalogPage } from '@/components/rag/catalog-page';
import { RagAuditList } from '@/components/rag/audit-list';
export default function AuditPage() {
    return (
        <CatalogPage
            titleKey='audit.title'
            descriptionKey='audit.description'
            operation='admin.rag.audit'
        >
            <RagAuditList />
        </CatalogPage>
    );
}
