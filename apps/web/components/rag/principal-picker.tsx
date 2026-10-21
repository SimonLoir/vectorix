'use client';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import {
    CatalogPagination,
    CatalogQueryState,
    CatalogSearch,
    useCatalogPagination,
} from './catalog-controls';

export type Principal = { id: string; name: string };
/** Only loads a bounded, server-filtered page of principals within the authorized editor scope. */
export function PrincipalPicker({
    scope,
    selected,
    onSelect,
}: Readonly<{
    scope:
        | { collectionId: string; type: 'member' | 'group' }
        | { groupId: string };
    selected: Principal | null;
    onSelect: (value: Principal) => void;
}>) {
    const tr = useTranslations('rag');
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const radioName = useId();
    const input = { query: page.query, offset: page.offset, limit: page.limit };
    const options =
        'collectionId' in scope
            ? orpc.admin.rag.collections.grantCandidates.queryOptions({
                  input: { ...input, id: scope.collectionId, type: scope.type },
              })
            : orpc.admin.rag.groups.memberCandidates.queryOptions({
                  input: { ...input, id: scope.groupId },
              });
    const query = useQuery(options);
    return (
        <div className='space-y-3 rounded-lg border p-3'>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('principals.search')}
            />
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <div className='max-h-48 space-y-1 overflow-y-auto'>
                        {query.data.items.map((item) => (
                            <label
                                key={item.id}
                                className='flex items-center gap-3 rounded-md p-2 hover:bg-muted'
                            >
                                <input
                                    type='radio'
                                    name={radioName}
                                    checked={selected?.id === item.id}
                                    onChange={() => onSelect(item)}
                                />
                                <span className='min-w-0'>
                                    <span className='block truncate'>
                                        {item.name}
                                    </span>
                                    <span className='block truncate text-xs text-muted-foreground'>
                                        {item.id}
                                    </span>
                                </span>
                            </label>
                        ))}
                    </div>
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {selected && (
                <p className='text-sm'>
                    {tr('principals.selection')}
                    <strong>{selected.name}</strong>
                </p>
            )}
        </div>
    );
}
