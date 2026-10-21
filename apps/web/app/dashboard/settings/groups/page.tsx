import { CatalogPage } from '@/components/rag/catalog-page';
import { GroupsManager } from '@/components/rag/groups/groups-manager';
export default function GroupsPage() {
    return (
        <CatalogPage
            titleKey='groups.title'
            descriptionKey='groups.description'
            operation='admin.rag.groups.list'
        >
            <GroupsManager />
        </CatalogPage>
    );
}
