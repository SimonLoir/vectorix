import { CatalogPage } from '@/components/rag/catalog-page';
import { DocumentDetail } from '@/components/rag/documents/document-detail';
export default async function DocumentPage({
    params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
    const { id } = await params;
    return (
        <CatalogPage
            titleKey='documents.detailTitle'
            descriptionKey='documents.detailDescription'
            operation='admin.rag.documents.details'
        >
            <DocumentDetail key={id} id={id} />
        </CatalogPage>
    );
}
