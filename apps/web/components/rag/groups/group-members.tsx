'use client';
import { useTranslations } from 'next-intl';
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
    const tr = useTranslations('rag');
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
            title={tr('groups.membersTitle', { name: group.name })}
            description={tr('groups.membersHint')}
            busy={mutation.busy}
            onClose={onClose}
        >
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('groups.searchMembers')}
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
                                        {tr('groups.removeMember')}
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
                        {adding
                            ? tr('groups.closeSelection')
                            : tr('groups.addMember')}
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
                                {tr('groups.addToGroup')}
                            </Button>
                        </fieldset>
                    )}
                </div>
            )}
            <ActionError error={mutation.error} />
            {removing && (
                <ConfirmCatalogAction
                    title={tr('groups.removeTitle')}
                    description={tr('groups.removeDescription', {
                        name: removing.name,
                    })}
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
