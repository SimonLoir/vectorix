import { CatalogPage } from '@/components/rag/catalog-page';
import { RagAuditList } from '@/components/rag/audit-list';
export default function AuditPage() {
    return (
        <CatalogPage
            title='Journal du catalogue'
            description='Historique des modifications de configuration, des accès et des quotas. Aucun secret n’est enregistré dans ce journal.'
            operation='admin.rag.audit'
        >
            <RagAuditList />
        </CatalogPage>
    );
}
