'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { Input } from '@repo/ui/input';
import { Button } from '@repo/ui/button';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { RequestErrorState } from '@/components/request-error-state';

export function useCatalogPagination() {
    const [query, setQuery] = useState('');
    const [offset, setOffset] = useState(0);
    return {
        query,
        offset,
        limit: 25,
        setOffset,
        search(value: string) {
            setQuery(value);
            setOffset(0);
        },
    };
}
export function CatalogSearch({
    value,
    onChange,
    label,
}: Readonly<{
    value: string;
    onChange: (value: string) => void;
    label?: string;
}>) {
    const tr = useTranslations('rag');
    return (
        <Input
            type='search'
            aria-label={label ?? tr('common.search')}
            placeholder={label ?? tr('common.search')}
            maxLength={200}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className='max-w-md'
        />
    );
}
export function CatalogPagination({
    offset,
    total,
    onChange,
    limit = 25,
}: Readonly<{
    offset: number;
    total: number;
    onChange: (offset: number) => void;
    limit?: number;
}>) {
    const tr = useTranslations('rag');
    return (
        <div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
            <span className='text-muted-foreground'>
                {total === 0
                    ? tr('common.empty')
                    : tr('common.range', {
                          from: Math.min(offset + 1, total),
                          to: Math.min(offset + limit, total),
                          total,
                      })}
            </span>
            <div className='flex gap-2'>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={offset === 0}
                    onClick={() => onChange(Math.max(0, offset - limit))}
                >
                    {tr('common.previous')}
                </Button>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={offset + limit >= total}
                    onClick={() => onChange(offset + limit)}
                >
                    {tr('common.next')}
                </Button>
            </div>
        </div>
    );
}
export function CatalogQueryState({
    query,
}: Readonly<{
    query: {
        isPending: boolean;
        isError: boolean;
        error: Error | null;
        refetch: () => unknown;
    };
}>) {
    const tr = useTranslations('rag');
    if (query.isError)
        return (
            <RequestErrorState
                errorKey={requestErrorKey(query.error)}
                onRetry={query.refetch}
            />
        );
    return query.isPending ? <p role='status'>{tr('common.loading')}</p> : null;
}
