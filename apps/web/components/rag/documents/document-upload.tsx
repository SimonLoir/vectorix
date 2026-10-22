'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Label } from '@repo/ui/label';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';

export function DocumentUpload({ onClose }: Readonly<{ onClose: () => void }>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const router = useRouter();
    const action = useCatalogAction();
    const [selection, setSelection] = useState<{
        file: File;
        requestId: string;
    } | null>(null);
    const valid =
        selection &&
        selection.file.size > 0 &&
        selection.file.size <= 25 * 1024 * 1024 &&
        /\.(txt|md|markdown|pdf|docx)$/i.test(selection.file.name);
    return (
        <CatalogDialog
            title={tr('documents.upload')}
            description={tr('documents.uploadHint')}
            busy={action.busy}
            onClose={onClose}
        >
            <form
                className='space-y-5'
                onSubmit={(event) => {
                    event.preventDefault();
                    if (valid)
                        void action.run(async () => {
                            const result =
                                await client.admin.rag.documents.upload(
                                    selection
                                );
                            router.push(`/dashboard/documents/${result.id}`);
                        }, onClose);
                }}
            >
                <div className='space-y-2'>
                    <Label htmlFor='document-file'>
                        {tr('documents.file')}
                    </Label>
                    <Input
                        id='document-file'
                        type='file'
                        accept='.txt,.md,.markdown,.pdf,.docx'
                        aria-describedby='document-file-budget'
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
                    <p
                        id='document-file-budget'
                        className='text-sm text-muted-foreground'
                    >
                        {tr('documents.extractionBudgetHint')}
                    </p>
                </div>
                {selection && !valid && (
                    <p role='alert'>{tr('documents.invalidFile')}</p>
                )}
                <ActionError
                    error={action.error ? tr('documents.uploadFailed') : null}
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
                    <Button disabled={!valid || action.busy}>
                        {tr(
                            action.busy
                                ? 'documents.uploading'
                                : 'documents.upload'
                        )}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
