'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { Button } from '@repo/ui/button';
import {
    CatalogPagination,
    CatalogSearch,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';
import { ConfirmCatalogAction } from '../catalog-dialog';
import { GrantForm } from './grant-form';
import type { Grant } from '../types';

export function CollectionGrants({ id }: Readonly<{ id: string }>) {
    const tr = useTranslations('rag');
    const { orpc, client } = useORPC();
    const page = useCatalogPagination();
    const [editing, setEditing] = useState<Grant | 'new' | null>(null);
    const [removing, setRemoving] = useState<Grant | null>(null);
    const query = useQuery(
        orpc.admin.rag.collections.grants.queryOptions({
            input: {
                id,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        })
    );
    return (
        <section className='rounded-xl border p-5 space-y-4'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
                <h2 className='text-lg font-semibold'>{tr('access.title')}</h2>
                <Button variant='outline' onClick={() => setEditing('new')}>
                    {tr('access.grant')}
                </Button>
            </div>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('access.search')}
            />
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <ul className='divide-y'>
                        {query.data.items.map((item) => (
                            <li
                                key={`${item.target.type}:${item.target.id}`}
                                className='flex flex-wrap items-center justify-between gap-3 py-4'
                            >
                                <div>
                                    <p className='font-medium'>
                                        {item.name}{' '}
                                        <span className='text-sm text-muted-foreground'>
                                            ·{' '}
                                            {item.target.type === 'group'
                                                ? tr('common.group')
                                                : tr('common.member')}
                                        </span>
                                    </p>
                                    <p className='text-sm text-muted-foreground'>
                                        {[
                                            item.permissions.read &&
                                                tr('common.read'),
                                            item.permissions.manageDocuments &&
                                                tr('common.documents'),
                                            item.permissions.administer &&
                                                tr('common.administer'),
                                        ]
                                            .filter(Boolean)
                                            .join(' · ') || tr('access.none')}
                                    </p>
                                </div>
                                <div className='flex gap-2'>
                                    <Button
                                        variant='outline'
                                        size='sm'
                                        onClick={() => setEditing(item)}
                                    >
                                        {tr('access.editAction')}
                                    </Button>
                                    <Button
                                        variant='ghost'
                                        size='sm'
                                        onClick={() => setRemoving(item)}
                                    >
                                        {tr('access.remove')}
                                    </Button>
                                </div>
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
            {editing && (
                <GrantForm
                    id={id}
                    existing={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(null)}
                />
            )}
            {removing && (
                <ConfirmCatalogAction
                    title={tr('access.removeTitle')}
                    description={tr('access.removeDescription', {
                        name: removing.name,
                    })}
                    action={() =>
                        client.admin.rag.collections.removeGrant({
                            id,
                            target: removing.target,
                        })
                    }
                    onClose={() => setRemoving(null)}
                />
            )}
        </section>
    );
}
