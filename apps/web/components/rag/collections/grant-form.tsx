'use client';
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
            title={existing ? 'Modifier un accès' : 'Accorder un accès'}
            description='Ces droits complètent les permissions de l’organisation. Un lecteur doit disposer explicitement du droit de lecture.'
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
                            {type === 'group' ? 'Groupe' : 'Membre'}
                        </p>
                    ) : (
                        <>
                            <SelectField
                                label='Type de bénéficiaire'
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
                                <option value='member'>Membre</option>
                                <option value='group'>Groupe</option>
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
                        label='Lire et rechercher dans la collection'
                        name='read'
                        defaultChecked={existing?.permissions.read ?? true}
                    />
                    <CheckField
                        label='Gérer les documents de la collection'
                        name='manageDocuments'
                        defaultChecked={
                            existing?.permissions.manageDocuments ?? false
                        }
                    />
                    <CheckField
                        label='Administrer la collection'
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
                        Annuler
                    </Button>
                    <Button disabled={mutation.busy || !selected}>
                        Enregistrer l’accès
                    </Button>
                </div>
            </form>
        </CatalogDialog>
    );
}
