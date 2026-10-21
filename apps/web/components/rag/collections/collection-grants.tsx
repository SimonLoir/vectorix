'use client';
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
                <h2 className='text-lg font-semibold'>Accès à la collection</h2>
                <Button variant='outline' onClick={() => setEditing('new')}>
                    Accorder un accès
                </Button>
            </div>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label='Rechercher un accès'
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
                                                ? 'Groupe'
                                                : 'Membre'}
                                        </span>
                                    </p>
                                    <p className='text-sm text-muted-foreground'>
                                        {[
                                            item.permissions.read && 'Lecture',
                                            item.permissions.manageDocuments &&
                                                'Documents',
                                            item.permissions.administer &&
                                                'Administration',
                                        ]
                                            .filter(Boolean)
                                            .join(' · ') ||
                                            'Aucun droit accordé'}
                                    </p>
                                </div>
                                <div className='flex gap-2'>
                                    <Button
                                        variant='outline'
                                        size='sm'
                                        onClick={() => setEditing(item)}
                                    >
                                        Modifier l’accès
                                    </Button>
                                    <Button
                                        variant='ghost'
                                        size='sm'
                                        onClick={() => setRemoving(item)}
                                    >
                                        Retirer l’accès
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
                    title='Retirer cet accès ?'
                    description={`Le droit direct de ${removing.name} sera retiré. D’autres appartenances à des groupes peuvent encore donner accès à la collection.`}
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
