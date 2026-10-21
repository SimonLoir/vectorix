'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import { CatalogDialog } from '../catalog-dialog';
import { ActionError, useCatalogAction } from '../catalog-action';
import { CheckField, SelectField } from '../form-fields';
import { PrincipalPicker, type Principal } from '../principal-picker';
import type { Grant } from '../types';

export function GrantForm({
    id,
    existing,
    onClose,
}: Readonly<{ id: string; existing?: Grant; onClose: () => void }>) {
    const tr = useTranslations('rag');
    const { client } = useORPC();
    const mutation = useCatalogAction();
    const [type, setType] = useState<'member' | 'group'>(
        existing?.target.type ?? 'member'
    );
    const [selected, setSelected] = useState<Principal | null>(
        existing ? { id: existing.target.id, name: existing.name } : null
    );
    return (
        <CatalogDialog
            title={existing ? tr('access.edit') : tr('access.grant')}
            description={tr('access.description')}
            busy={mutation.busy}
            onClose={onClose}
        >
            <form
                className='space-y-4'
                onSubmit={(event) => {
                    event.preventDefault();
                    if (!selected) return;
                    const form = new FormData(event.currentTarget);
                    void mutation.run(
                        () =>
                            client.admin.rag.collections.setGrant({
                                id,
                                target: { type, id: selected.id },
                                permissions: {
                                    read: form.has('read'),
                                    manageDocuments:
                                        form.has('manageDocuments'),
                                    administer: form.has('administer'),
                                },
                            }),
                        onClose
                    );
                }}
            >
                <fieldset disabled={mutation.busy} className='space-y-4'>
                    {existing ? (
                        <p className='font-medium'>
                            {existing.name} ·{' '}
                            {type === 'group'
                                ? tr('common.group')
                                : tr('common.member')}
                        </p>
                    ) : (
                        <>
                            <SelectField
                                label={tr('access.target')}
                                value={type}
                                onChange={(event) => {
                                    setType(
                                        event.target.value === 'group'
                                            ? 'group'
                                            : 'member'
                                    );
                                    setSelected(null);
                                }}
                            >
                                <option value='member'>
                                    {tr('common.member')}
                                </option>
                                <option value='group'>
                                    {tr('common.group')}
                                </option>
                            </SelectField>
                            <PrincipalPicker
                                key={type}
                                scope={{ collectionId: id, type }}
                                selected={selected}
                                onSelect={setSelected}
                            />
                        </>
                    )}
                    <CheckField
                        label={tr('access.read')}
                        name='read'
                        defaultChecked={existing?.permissions.read ?? true}
                    />
                    <CheckField
                        label={tr('access.manageDocuments')}
                        name='manageDocuments'
                        defaultChecked={
                            existing?.permissions.manageDocuments ?? false
                        }
                    />
                    <CheckField
                        label={tr('access.administer')}
                        name='administer'
                        defaultChecked={
                            existing?.permissions.administer ?? false
                        }
                    />
                </fieldset>
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
                    <Button disabled={mutation.busy || !selected}>
                        {tr('access.save')}
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
