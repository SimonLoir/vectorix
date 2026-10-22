import { CatalogPage } from '@/components/rag/catalog-page';
import { QuotaOverview } from '@/components/rag/quota-overview';
import { RecordedActivitySection } from '@/components/rag/telemetry/recorded-activity-section';
export default function UsagePage() {
    return (
        <CatalogPage
            titleKey='usage.title'
            descriptionKey='usage.description'
            operation='admin.rag.quota'
        >
            <QuotaOverview />
            <RecordedActivitySection />
        </CatalogPage>
    );
}
