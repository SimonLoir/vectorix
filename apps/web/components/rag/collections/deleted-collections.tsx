'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import {
    CatalogSearch,
    CatalogPagination,
    useCatalogPagination,
} from '../catalog-controls';
import { CatalogDialog } from '../catalog-dialog';
import { IndexTasks } from '../indexing/index-tasks';
import { IndexQueryState } from '../indexing/index-state';

export function DeletedCollections() {
    const tr = useTranslations('rag.indexing');
    const format = useFormatter();
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const [selected, setSelected] = useState<{
        id: string;
        name: string;
    } | null>(null);
    const query = useQuery({
        ...orpc.admin.rag.indexing.trash.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 5000),
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h2 className='text-lg font-semibold'>
                {tr('deletedCollections')}
            </h2>
            <p className='text-sm text-muted-foreground'>{tr('deletedHint')}</p>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('deletedSearch')}
            />
            <IndexQueryState query={query} />
            {data && (
                <>
                    <ul className='space-y-3'>
                        {data.items.map((item) => (
                            <li
                                key={item.id}
                                className='space-y-2 rounded-lg border p-3 text-sm'
                            >
                                <p className='break-words font-medium'>
                                    {item.name}
                                </p>
                                <p>
                                    {tr('cleanupProgress', {
                                        date: format.dateTime(item.deletedAt, {
                                            dateStyle: 'medium',
                                            timeStyle: 'short',
                                        }),
                                        pending: item.pendingTasks,
                                        failed: item.failedTasks,
                                    })}
                                </p>
                                <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() => setSelected(item)}
                                >
                                    {tr('inspectCleanup')}
                                </Button>
                            </li>
                        ))}
                    </ul>
                    <CatalogPagination
                        offset={page.offset}
                        total={data.total}
                        limit={page.limit}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {selected && (
                <CatalogDialog
                    title={tr('inspectCleanup')}
                    description={tr('deletedCleanupHint', {
                        name: selected.name,
                    })}
                    onClose={() => setSelected(null)}
                >
                    <IndexTasks collectionId={selected.id} canManage />
                </CatalogDialog>
            )}
        </section>
    );
}
