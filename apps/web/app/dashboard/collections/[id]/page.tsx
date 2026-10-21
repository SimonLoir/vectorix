import { CatalogPage } from '@/components/rag/catalog-page';
import { CollectionDetail } from '@/components/rag/collections/collection-detail';
export default async function CollectionPage({
    params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
    const { id } = await params;
    return (
        <CatalogPage
            titleKey='collections.detailTitle'
            descriptionKey='collections.detailDescription'
            operation='admin.rag.collections.get'
        >
            <CollectionDetail key={id} id={id} />
        </CatalogPage>
    );
}
