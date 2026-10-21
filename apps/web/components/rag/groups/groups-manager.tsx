'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { Button } from '@repo/ui/button';
import {
    CatalogSearch,
    CatalogPagination,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';
import { ConfirmCatalogAction } from '../catalog-dialog';
import { GroupForm } from './group-form';
import { GroupMembers } from './group-members';
import type { Group } from '../types';

export function GroupsManager() {
    const tr = useTranslations('rag');
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const page = useCatalogPagination();
    const [editing, setEditing] = useState<Group | 'new' | null>(null);
    const [members, setMembers] = useState<Group | null>(null);
    const [deleting, setDeleting] = useState<Group | null>(null);
    const query = useQuery(
        orpc.admin.rag.groups.list.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        })
    );
    return (
        <div className='space-y-5'>
            <div className='flex flex-wrap justify-between gap-3'>
                <CatalogSearch
                    value={page.query}
                    onChange={page.search}
                    label={tr('groups.search')}
                />
                {canOperation('admin.rag.groups.create') && (
                    <Button onClick={() => setEditing('new')}>
                        {tr('groups.create')}
                    </Button>
                )}
            </div>
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <div className='rounded-xl border divide-y'>
                        {query.data.items.map((group) => (
                            <article
                                className='flex flex-wrap justify-between items-center gap-4 p-5'
                                key={group.id}
                            >
                                <div>
                                    <h2 className='font-semibold'>
                                        {group.name}
                                    </h2>
                                    <p className='text-sm text-muted-foreground'>
                                        {tr('groups.memberCount', {
                                            count: group.memberCount,
                                        })}
                                    </p>
                                </div>
                                <div className='flex flex-wrap gap-2'>
                                    <Button
                                        variant='outline'
                                        onClick={() => setMembers(group)}
                                    >
                                        {tr('groups.members')}
                                    </Button>
                                    {canOperation(
                                        'admin.rag.groups.rename'
                                    ) && (
                                        <Button
                                            variant='outline'
                                            onClick={() => setEditing(group)}
                                        >
                                            {tr('common.rename')}
                                        </Button>
                                    )}
                                    {canOperation(
                                        'admin.rag.groups.delete'
                                    ) && (
                                        <Button
                                            variant='ghost'
                                            onClick={() => setDeleting(group)}
                                        >
                                            {tr('common.delete')}
                                        </Button>
                                    )}
                                </div>
                            </article>
                        ))}
                        {query.data.total === 0 && (
                            <p className='p-8 text-center text-muted-foreground'>
                                {tr('groups.empty')}
                            </p>
                        )}
                    </div>
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {editing && (
                <GroupForm
                    existing={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(null)}
                />
            )}
            {members && (
                <GroupMembers
                    group={members}
                    onClose={() => setMembers(null)}
                />
            )}
            {deleting && (
                <ConfirmCatalogAction
                    title={tr('groups.deleteTitle')}
                    description={tr('groups.deleteDescription', {
                        name: deleting.name,
                    })}
                    onClose={() => setDeleting(null)}
                    action={() =>
                        client.admin.rag.groups.delete({ id: deleting.id })
                    }
                />
            )}
        </div>
    );
}
