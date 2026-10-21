import { CatalogPage } from '@/components/rag/catalog-page';
import { QuotaOverview } from '@/components/rag/quota-overview';
export default function UsagePage() {
    return (
        <CatalogPage
            title='Usage et quotas'
            description='Consultez les ressources enregistrées et les limites de votre organisation.'
            operation='admin.rag.quota'
        >
            <QuotaOverview />
        </CatalogPage>
    );
}
