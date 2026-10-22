'use client';
import { useTranslations } from 'next-intl';
import { CatalogDialog } from '../catalog-dialog';
import { IndexTasks } from '../indexing/index-tasks';

/** Reuse the existing tombstone-only, server-authorized cleanup task workspace. */
export function DeletedCollectionCleanupDialog({
    collection,
    onClose,
}: Readonly<{
    collection: { id: string; name: string };
    onClose: () => void;
}>) {
    const tr = useTranslations('rag.indexing');
    return (
        <CatalogDialog
            title={tr('inspectCleanup')}
            description={tr('deletedCleanupHint', { name: collection.name })}
            onClose={onClose}
        >
            <IndexTasks collectionId={collection.id} canManage />
        </CatalogDialog>
    );
}
