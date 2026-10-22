'use client';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import type { OperationItem } from './types';

/** Targets come from the current scoped overview; destination screens recheck their own current access. */
export function OperationRecovery({
    item,
    onInspectCleanup,
}: Readonly<{
    item: OperationItem;
    onInspectCleanup: (collection: { id: string; name: string }) => void;
}>) {
    const tr = useTranslations('rag.operations');
    const { canOperation } = useVectorixPermissions();
    const target = item.target;
    if (target.type === 'COLLECTION' && target.deleted) {
        return (
            canOperation('admin.rag.indexing.tasks') && (
                <Button
                    size='sm'
                    variant='outline'
                    aria-label={tr('inspectNamedCleanup', { name: item.name })}
                    onClick={() =>
                        onInspectCleanup({ id: target.id, name: item.name })
                    }
                >
                    {tr('inspectCleanup')}
                </Button>
            )
        );
    }
    const document = target.type === 'DOCUMENT';
    const operation = document
        ? target.deleted
            ? 'admin.rag.documents.lifecycle'
            : 'admin.rag.documents.details'
        : 'admin.rag.collections.get';
    if (!canOperation(operation)) return null;
    const id = encodeURIComponent(target.id);
    const href = document
        ? `/dashboard/documents/${target.deleted ? 'deleted/' : ''}${id}`
        : `/dashboard/collections/${id}`;
    return (
        <Link
            className='inline-flex rounded-md border px-3 py-2 font-medium underline-offset-4 hover:underline focus-visible:outline-2'
            href={href}
            aria-label={tr('openNamedWorkspace', { name: item.name })}
        >
            {tr('openRecovery')}
        </Link>
    );
}
