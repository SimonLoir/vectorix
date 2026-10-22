'use client';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import {
    CatalogPagination,
    CatalogSearch,
    useCatalogPagination,
} from '../catalog-controls';
import { ActionError, useCatalogAction } from '../catalog-action';
import { DocumentQueryState } from './query-state';

export function DocumentCollections({
    id,
    ready,
}: Readonly<{ id: string; ready: boolean }>) {
    const tr = useTranslations('rag.documents');
    const { orpc, client } = useORPC();
    const action = useCatalogAction();
    const page = useCatalogPagination();
    const query = useQuery(
        orpc.admin.rag.documents.collectionCandidates.queryOptions({
            retry: false,
            staleTime: 0,
            input: {
                id,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        })
    );
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h2 className='text-lg font-semibold'>{tr('collections')}</h2>
            <p className='text-sm text-muted-foreground'>
                {tr('collectionsHint')}
            </p>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('searchCollections')}
            />
            <DocumentQueryState query={query} />
            <ActionError error={action.error ? tr('actionFailed') : null} />
            {!query.isError && query.data && (
                <>
                    <div className='divide-y'>
                        {query.data.items.map((item) => (
                            <div
                                key={item.id}
                                className='flex items-center justify-between gap-4 py-3'
                            >
                                <Link
                                    href={`/dashboard/collections/${item.id}`}
                                    className='break-words underline'
                                >
                                    {item.name}
                                </Link>
                                <Button
                                    variant={
                                        item.attached ? 'secondary' : 'outline'
                                    }
                                    disabled={
                                        action.busy ||
                                        (!item.attached && !ready)
                                    }
                                    onClick={() =>
                                        void action.run(() =>
                                            client.admin.rag.documents.setCollection(
                                                {
                                                    id,
                                                    collectionId: item.id,
                                                    attached: !item.attached,
                                                }
                                            )
                                        )
                                    }
                                >
                                    {tr(item.attached ? 'detach' : 'attach')}
                                </Button>
                            </div>
                        ))}
                    </div>
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
        </section>
    );
}
