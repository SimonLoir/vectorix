'use client';
import { useTranslations } from 'next-intl';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { TextField } from '../form-fields';
import type { Group } from '../types';
export function GroupForm({
    existing,
    onClose,
}: Readonly<{ existing?: Group; onClose: () => void }>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const mutation = useCatalogAction();
    return (
        <CatalogDialog
            title={existing ? tr('groups.rename') : tr('groups.create')}
            description={tr('groups.formDescription')}
            busy={mutation.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    const name = String(
                        new FormData(event.currentTarget).get('name')
                    );
                    void mutation.run(
                        () =>
                            existing
                                ? client.admin.rag.groups.rename({
                                      id: existing.id,
                                      name,
                                  })
                                : client.admin.rag.groups.create({ name }),
                        onClose
                    );
                }}
            >
                <TextField
                    label={tr('groups.name')}
                    name='name'
                    required
                    maxLength={100}
                    defaultValue={existing?.name}
                    disabled={mutation.busy}
                />
                <ActionError error={mutation.error} />
                <div className='flex justify-end gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={mutation.busy}
                        onClick={onClose}
                    >
                        {tr('common.cancel')}
                    </Button>
                    <Button disabled={mutation.busy}>
                        {tr('common.save')}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
