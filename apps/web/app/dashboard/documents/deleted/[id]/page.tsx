import { CatalogPage } from '@/components/rag/catalog-page';
import { DocumentLifecycle } from '@/components/rag/documents/document-lifecycle';

export default async function DeletedDocumentPage({
    params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
    const { id } = await params;
    return (
        <CatalogPage
            titleKey='documents.lifecycle.deletedTitle'
            descriptionKey='documents.lifecycle.deletedDescription'
            operation='admin.rag.documents.lifecycle'
        >
            <DocumentLifecycle key={id} id={id} deletedPage />
        </CatalogPage>
    );
}
