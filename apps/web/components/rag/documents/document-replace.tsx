'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { DocumentRetention, validRetention } from './document-retention';

export function DocumentReplace({
    id,
    expectedVersionId,
    onClose,
}: Readonly<{
    id: string;
    expectedVersionId: string;
    onClose: () => void;
}>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const action = useCatalogAction();
    const [retention, setRetention] = useState('7');
    const [selection, setSelection] = useState<{
        file: File;
        requestId: string;
    } | null>(null);
    const validFile =
        selection &&
        selection.file.size > 0 &&
        selection.file.size <= 25 * 1024 * 1024 &&
        /\.(txt|md|markdown)$/i.test(selection.file.name);
    return (
        <CatalogDialog
            title={tr('documents.lifecycle.replace')}
            description={tr('documents.lifecycle.replaceHint')}
            busy={action.busy}
            onClose={onClose}
        >
            <form
                className='space-y-5'
                onSubmit={(event) => {
                    event.preventDefault();
                    if (validFile && validRetention(retention))
                        void action.run(
                            () =>
                                client.admin.rag.documents.replace({
                                    id,
                                    expectedVersionId,
                                    ...selection,
                                    retentionDays: Number(retention),
                                }),
                            onClose
                        );
                }}
            >
                <div className='space-y-2'>
                    <Label htmlFor='replacement-file'>
                        {tr('documents.file')}
                    </Label>
                    <Input
                        id='replacement-file'
                        type='file'
                        accept='.txt,.md,.markdown'
                        required
                        disabled={action.busy}
                        onChange={(event) => {
                            const file = event.target.files?.[0];
                            setSelection(
                                file
                                    ? { file, requestId: crypto.randomUUID() }
                                    : null
                            );
                        }}
                    />
                </div>
                {selection && !validFile && (
                    <p role='alert'>{tr('documents.invalidFile')}</p>
                )}
                <DocumentRetention
                    value={retention}
                    onChange={setRetention}
                    disabled={action.busy}
                />
                <ActionError
                    error={
                        action.error
                            ? tr('documents.lifecycle.replaceFailed')
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
                        disabled={
                            !validFile ||
                            !validRetention(retention) ||
                            action.busy
                        }
                    >
                        {tr(
                            action.busy
                                ? 'documents.uploading'
                                : 'documents.lifecycle.confirmReplace'
                        )}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
