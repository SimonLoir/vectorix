'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import {
    CatalogPagination,
    CatalogSearch,
    useCatalogPagination,
} from '../catalog-controls';
import { SelectField } from '../form-fields';
import { IndexQueryState } from '../indexing/index-state';
import { DeletedCollectionCleanupDialog } from '../collections/deleted-collection-cleanup-dialog';
import { OperationCounts } from './operation-counts';
import { OperationList } from './operation-list';
import type { OperationCategory, OperationFilter } from './types';

const categories = ['INGESTION', 'DOCUMENT_CLEANUP', 'INDEXING'] as const;
const states = [
    'ALL',
    'UPLOADING',
    'DUE',
    'SCHEDULED',
    'LEASED',
    'EXPIRED',
    'FAILED',
] as const;
const maximumOffset = 100_000;

export function OperationsOverview() {
    const tr = useTranslations('rag.operations');
    const format = useFormatter();
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const [category, setCategory] = useState<OperationCategory>('INDEXING');
    const [state, setState] = useState<OperationFilter>('ALL');
    const [cleanup, setCleanup] = useState<{ id: string; name: string } | null>(
        null
    );
    const query = useQuery({
        ...orpc.admin.rag.operations.overview.queryOptions({
            input: {
                category,
                state,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        retry: false,
        staleTime: 0,
        refetchInterval: (current) => (current.state.error ? false : 15_000),
    });
    const data = query.isError ? undefined : query.data;
    const selectedVisible =
        cleanup &&
        data?.items.some(
            (item) =>
                item.target.type === 'COLLECTION' &&
                item.target.deleted &&
                item.target.id === cleanup.id
        );
    return (
        <div className='space-y-6'>
            <p className='text-sm text-muted-foreground'>{tr('scope')}</p>
            <p className='text-sm text-muted-foreground'>{tr('unmeasured')}</p>
            <IndexQueryState query={query} />
            {data && (
                <>
                    <p className='text-sm'>
                        {tr('observedAt', {
                            date: format.dateTime(data.observedAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                            }),
                        })}
                    </p>
                    <OperationCounts counts={data.counts} />
                </>
            )}
            <section className='space-y-4 rounded-xl border p-5'>
                <h2 className='font-semibold'>{tr('detailsTitle')}</h2>
                <p className='text-sm text-muted-foreground'>
                    {tr('detailsHint')}
                </p>
                <div className='flex flex-wrap items-end gap-4'>
                    <SelectField
                        label={tr('category')}
                        value={category}
                        onChange={(event) => {
                            const next = categories.find(
                                (candidate) => candidate === event.target.value
                            );
                            if (next) {
                                setCategory(next);
                                page.setOffset(0);
                            }
                        }}
                    >
                        {categories.map((value) => (
                            <option key={value} value={value}>
                                {tr(`categories.${value}`)}
                            </option>
                        ))}
                    </SelectField>
                    <SelectField
                        label={tr('state')}
                        value={state}
                        onChange={(event) => {
                            const next = states.find(
                                (candidate) => candidate === event.target.value
                            );
                            if (next) {
                                setState(next);
                                page.setOffset(0);
                            }
                        }}
                    >
                        {states.map((value) => (
                            <option key={value} value={value}>
                                {tr(`states.${value}`)}
                            </option>
                        ))}
                    </SelectField>
                    <CatalogSearch
                        value={page.query}
                        onChange={page.search}
                        label={tr('search')}
                    />
                    <Button
                        variant='outline'
                        disabled={query.isFetching}
                        onClick={() => void query.refetch()}
                    >
                        {tr('refresh')}
                    </Button>
                </div>
                <p className='text-sm text-muted-foreground'>
                    {tr('timingHint')}
                </p>
                {data && (
                    <>
                        <p role='status' className='text-sm'>
                            {tr('visibleTotal', { count: data.visibleTotal })}
                        </p>
                        {data.items.length === 0 ? (
                            <p>{tr('empty')}</p>
                        ) : (
                            <OperationList
                                items={data.items}
                                observedAt={data.observedAt}
                                onInspectCleanup={setCleanup}
                            />
                        )}
                        <CatalogPagination
                            offset={page.offset}
                            total={Math.min(
                                data.visibleTotal,
                                maximumOffset + page.limit
                            )}
                            limit={page.limit}
                            onChange={page.setOffset}
                        />
                        {data.visibleTotal > maximumOffset + page.limit && (
                            <p className='text-sm text-muted-foreground'>
                                {tr('paginationLimited', {
                                    count: maximumOffset + page.limit,
                                })}
                            </p>
                        )}
                    </>
                )}
            </section>
            {cleanup && selectedVisible && (
                <DeletedCollectionCleanupDialog
                    collection={cleanup}
                    onClose={() => setCleanup(null)}
                />
            )}
        </div>
    );
}
