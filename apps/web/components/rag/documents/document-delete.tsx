'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { DocumentRetention, validRetention } from './document-retention';

export function DocumentDelete({
    id,
    expectedVersionId,
    name,
    onClose,
}: Readonly<{
    id: string;
    expectedVersionId: string;
    name: string;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const router = useRouter();
    const { client } = useORPC();
    const action = useCatalogAction();
    const [retention, setRetention] = useState('0');
    return (
        <CatalogDialog
            title={tr('documents.lifecycle.delete')}
            description={tr('documents.lifecycle.deleteHint', { name })}
            busy={action.busy}
            onClose={onClose}
        >
            <form
                className='space-y-5'
                onSubmit={(event) => {
                    event.preventDefault();
                    if (validRetention(retention))
                        void action.run(async () => {
                            await client.admin.rag.documents.delete({
                                id,
                                expectedVersionId,
                                retentionDays: Number(retention),
                            });
                            router.replace(
                                `/dashboard/documents/deleted/${id}`
                            );
                        }, onClose);
                }}
            >
                <p className='rounded-md border border-destructive/40 p-3 text-sm'>
                    {tr('documents.lifecycle.deleteWarning')}
                </p>
                <DocumentRetention
                    value={retention}
                    onChange={setRetention}
                    disabled={action.busy}
                    deletion
                />
                <ActionError
                    error={
                        action.error
                            ? tr('documents.lifecycle.deleteFailed')
                            : null
                    }
                />
                <div className='flex justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={action.busy}
                        onClick={onClose}
                    >
                        {tr('common.cancel')}
                    </Button>
                    <Button
                        variant='destructive'
                        disabled={!validRetention(retention) || action.busy}
                    >
                        {tr(
                            action.busy
                                ? 'common.working'
                                : 'documents.lifecycle.confirmDelete'
                        )}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
