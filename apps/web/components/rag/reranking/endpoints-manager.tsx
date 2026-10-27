'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { RequestErrorState } from '@/components/request-error-state';
import {
    CatalogPagination,
    CatalogQueryState,
    CatalogSearch,
    useCatalogPagination,
} from '../catalog-controls';
import { RerankEndpointConfirmation } from './endpoint-confirmation';
import { RerankEndpointCard } from './endpoint-card';
import { RerankEndpointForm } from './endpoint-form';
import type { EndpointConfirmation, RerankEndpoint } from './types';

/** Self-hosted endpoint credentials have their own API and never widen the legacy provider list. */
export function RerankEndpointsManager({
    active,
}: Readonly<{ active: boolean }>) {
    const tr = useTranslations('rag.reranking.endpoints');
    const { orpc } = useORPC();
    const { canOperation, refresh } = useVectorixPermissions();
    const page = useCatalogPagination();
    const allowed = canOperation('admin.rag.reranking.endpoints.list');
    const query = useQuery({
        ...orpc.admin.rag.reranking.endpoints.list.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        enabled: active && allowed,
        staleTime: 0,
        retry: false,
    });
    const [editing, setEditing] = useState<RerankEndpoint | 'new' | null>(null);
    const [confirmation, setConfirmation] =
        useState<EndpointConfirmation | null>(null);
    if (!allowed)
        return <RequestErrorState errorKey='permission' onRetry={refresh} />;
    const canEdit =
        editing === 'new'
            ? canOperation('admin.rag.reranking.endpoints.create')
            : canOperation('admin.rag.reranking.endpoints.update');
    const canConfirm =
        confirmation &&
        canOperation(`admin.rag.reranking.endpoints.${confirmation.kind}`);
    return (
        <section className='space-y-5'>
            <header className='space-y-2'>
                <h2 className='text-xl font-semibold'>{tr('title')}</h2>
                <p className='max-w-3xl text-sm text-muted-foreground'>
                    {tr('description')}
                </p>
            </header>
            <div className='space-y-2 rounded-xl border bg-muted/30 p-4 text-sm'>
                <p>{tr('priority')}</p>
                <p className='text-muted-foreground'>{tr('bindingHint')}</p>
            </div>
            <div className='flex flex-wrap justify-between gap-3'>
                <CatalogSearch
                    value={page.query}
                    onChange={page.search}
                    label={tr('search')}
                />
                {canOperation('admin.rag.reranking.endpoints.create') && (
                    <Button
                        type='button'
                        className='h-auto max-w-full whitespace-normal'
                        onClick={() => setEditing('new')}
                    >
                        {tr('createAction')}
                    </Button>
                )}
            </div>
            {active && <CatalogQueryState query={query} />}
            {!query.isError && query.data && (
                <>
                    <div className='grid gap-4 lg:grid-cols-2'>
                        {query.data.items.map((item) => (
                            <RerankEndpointCard
                                key={item.id}
                                item={item}
                                onEdit={() => setEditing(item)}
                                onActivate={() =>
                                    setConfirmation({ item, kind: 'activate' })
                                }
                                onRemove={() =>
                                    setConfirmation({ item, kind: 'remove' })
                                }
                            />
                        ))}
                    </div>
                    {query.data.total === 0 && (
                        <p className='rounded-xl border border-dashed p-8 text-center text-muted-foreground'>
                            {tr('empty')}
                        </p>
                    )}
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                        limit={page.limit}
                    />
                </>
            )}
            {active && editing && canEdit && (
                <RerankEndpointForm
                    existing={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(null)}
                />
            )}
            {active && confirmation && canConfirm && (
                <RerankEndpointConfirmation
                    confirmation={confirmation}
                    onClose={() => setConfirmation(null)}
                />
            )}
        </section>
    );
}
