import { CatalogPage } from '@/components/rag/catalog-page';
import { GroupsManager } from '@/components/rag/groups/groups-manager';
export default function GroupsPage() {
    return (
        <CatalogPage
            title='Groupes'
            description='Regroupez les membres et accordez des accès aux collections.'
            operation='admin.rag.groups.list'
        >
            <GroupsManager />
        </CatalogPage>
    );
}
