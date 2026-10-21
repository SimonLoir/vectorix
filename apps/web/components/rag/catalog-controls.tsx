'use client';
import { useState } from 'react';
import { Input } from '@repo/ui/input';
import { Button } from '@repo/ui/button';

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
    label = 'Rechercher',
}: Readonly<{
    value: string;
    onChange: (value: string) => void;
    label?: string;
}>) {
    return (
        <Input
            type='search'
            aria-label={label}
            placeholder={label}
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
    return (
        <div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
            <span className='text-muted-foreground'>
                {total === 0
                    ? 'Aucun résultat'
                    : `${Math.min(offset + 1, total)}–${Math.min(offset + limit, total)} sur ${total}`}
            </span>
            <div className='flex gap-2'>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={offset === 0}
                    onClick={() => onChange(Math.max(0, offset - limit))}
                >
                    Précédent
                </Button>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={offset + limit >= total}
                    onClick={() => onChange(offset + limit)}
                >
                    Suivant
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
    if (query.isError)
        return (
            <div
                role='alert'
                className='rounded-lg border border-destructive/40 p-4'
            >
                <p>
                    {query.error?.message ??
                        'Impossible de charger ces données.'}
                </p>
                <Button
                    type='button'
                    className='mt-3'
                    variant='outline'
                    onClick={() => void query.refetch()}
                >
                    Réessayer
                </Button>
            </div>
        );
    if (query.isPending) return <p role='status'>Chargement…</p>;
    return null;
}
