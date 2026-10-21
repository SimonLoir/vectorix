'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { Button } from '@repo/ui/button';
import { CatalogDialog, ConfirmCatalogAction } from '../catalog-dialog';
import {
    CatalogPagination,
    CatalogSearch,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';
import { ActionError, useCatalogAction } from '../catalog-action';
import { PrincipalPicker, type Principal } from '../principal-picker';
import type { Group } from '../types';

export function GroupMembers({
    group,
    onClose,
}: Readonly<{ group: Group; onClose: () => void }>) {
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const page = useCatalogPagination();
    const mutation = useCatalogAction();
    const [adding, setAdding] = useState(false);
    const [selected, setSelected] = useState<Principal | null>(null);
    const [removing, setRemoving] = useState<{
        memberId: string;
        name: string;
    } | null>(null);
    const query = useQuery(
        orpc.admin.rag.groups.members.queryOptions({
            input: {
                id: group.id,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        })
    );
    return (
        <CatalogDialog
            title={`Membres · ${group.name}`}
            description='L’ajout à un groupe peut donner accès à ses collections. Vous devez aussi pouvoir gérer les droits de ces collections.'
            busy={mutation.busy}
            onClose={onClose}
        >
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label='Rechercher dans le groupe'
            />
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <ul className='divide-y'>
                        {query.data.items.map((member) => (
                            <li
                                className='flex items-center justify-between gap-3 py-3'
                                key={member.memberId}
                            >
                                <span>{member.name}</span>
                                {canOperation(
                                    'admin.rag.groups.removeMember'
                                ) && (
                                    <Button
                                        variant='ghost'
                                        size='sm'
                                        disabled={mutation.busy}
                                        onClick={() => setRemoving(member)}
                                    >
                                        Retirer du groupe
                                    </Button>
                                )}
                            </li>
                        ))}
                    </ul>
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {canOperation('admin.rag.groups.addMember') && (
                <div className='space-y-3 border-t pt-4'>
                    <Button
                        variant='outline'
                        disabled={mutation.busy}
                        onClick={() => setAdding((value) => !value)}
                    >
                        {adding ? 'Fermer la sélection' : 'Ajouter un membre'}
                    </Button>
                    {adding && (
                        <fieldset
                            disabled={mutation.busy}
                            className='space-y-3'
                        >
                            <PrincipalPicker
                                scope={{ groupId: group.id }}
                                selected={selected}
                                onSelect={setSelected}
                            />
                            <Button
                                disabled={!selected || mutation.busy}
                                onClick={() => {
                                    if (selected)
                                        void mutation.run(
                                            () =>
                                                client.admin.rag.groups.addMember(
                                                    {
                                                        id: group.id,
                                                        memberId: selected.id,
                                                    }
                                                ),
                                            () => {
                                                setSelected(null);
                                                setAdding(false);
                                            }
                                        );
                                }}
                            >
                                Ajouter au groupe
                            </Button>
                        </fieldset>
                    )}
                </div>
            )}
            <ActionError error={mutation.error} />
            {removing && (
                <ConfirmCatalogAction
                    title='Retirer ce membre ?'
                    description={`${removing.name} perdra les accès accordés par ce groupe.`}
                    onClose={() => setRemoving(null)}
                    action={() =>
                        client.admin.rag.groups.removeMember({
                            id: group.id,
                            memberId: removing.memberId,
                        })
                    }
                />
            )}
        </CatalogDialog>
    );
}
