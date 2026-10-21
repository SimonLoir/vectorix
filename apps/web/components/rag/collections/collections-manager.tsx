'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Database } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { Badge } from '@repo/ui/badge';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import {
    CatalogSearch,
    CatalogPagination,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';
import { CollectionForm } from './collection-form';

export function CollectionsManager() {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const page = useCatalogPagination();
    const [creating, setCreating] = useState(false);
    const query = useQuery(
        orpc.admin.rag.collections.list.queryOptions({
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
                    label={tr('collections.search')}
                />
                {canOperation('admin.rag.collections.create') && (
                    <Button onClick={() => setCreating(true)}>
                        {tr('collections.create')}
                    </Button>
                )}
            </div>
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
                        {query.data.items.map((item) => (
                            <Link
                                key={item.id}
                                href={`/dashboard/collections/${item.id}`}
                                className='rounded-xl border bg-card p-5 space-y-4 transition-colors hover:border-primary focus-visible:outline-2 focus-visible:outline-primary'
                            >
                                <div className='flex justify-between'>
                                    <Database className='size-5 text-muted-foreground' />
                                    <ArrowUpRight className='size-4' />
                                </div>
                                <h2 className='font-semibold text-lg break-words'>
                                    {item.name}
                                </h2>
                                <p className='text-sm text-muted-foreground line-clamp-2'>
                                    {item.description ||
                                        tr('collections.noDescription')}
                                </p>
                                <div className='text-sm'>
                                    <p>
                                        {item.configuration.provider} ·{' '}
                                        {item.configuration.model}
                                    </p>
                                    <p className='text-muted-foreground'>
                                        {tr('collections.dimensionsRevision', {
                                            dimensions:
                                                item.configuration.dimensions,
                                            revision:
                                                item.configurationRevision,
                                        })}
                                    </p>
                                </div>
                                <Badge variant='secondary'>
                                    {tr('collections.configurationOnly')}
                                </Badge>
                            </Link>
                        ))}
                    </div>
                    {query.data.total === 0 && (
                        <div className='rounded-xl border border-dashed p-10 text-center'>
                            <h2 className='font-medium'>
                                {tr('collections.empty')}
                            </h2>
                            <p className='mt-2 text-sm text-muted-foreground'>
                                {tr('collections.emptyHint')}
                            </p>
                        </div>
                    )}
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {creating && <CollectionForm onClose={() => setCreating(false)} />}
        </div>
    );
}
