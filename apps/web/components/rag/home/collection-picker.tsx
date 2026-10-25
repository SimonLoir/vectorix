'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Check, ChevronDown, Database } from 'lucide-react';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CatalogDialog } from '../catalog-dialog';
import {
    CatalogSearch,
    CatalogPagination,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';

export type CollectionSelection = Readonly<{ id: string; name: string }>;

/** Browse one server-filtered metadata page; unreadable rows never become selections. */
export function CollectionPicker({
    selected,
    disabled,
    onSelect,
}: Readonly<{
    selected: CollectionSelection | null;
    disabled: boolean;
    onSelect: (selection: CollectionSelection) => void;
}>) {
    const tr = useTranslations('rag.searchHome');
    const common = useTranslations('rag.common');
    const { orpc } = useORPC();
    const [open, setOpen] = useState(false);
    const page = useCatalogPagination();
    const query = useQuery({
        ...orpc.admin.rag.collections.list.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        enabled: open && !disabled,
        staleTime: 0,
        retry: false,
    });
    const data = query.isError ? undefined : query.data;
    return (
        <>
            <Button
                type='button'
                variant='outline'
                disabled={disabled}
                aria-haspopup='dialog'
                aria-expanded={open}
                aria-label={
                    selected
                        ? tr('selection', { name: selected.name })
                        : tr('chooseCollection')
                }
                className='max-w-full gap-2 bg-card sm:max-w-sm'
                onClick={() => setOpen(true)}
            >
                <Database
                    className='size-4 shrink-0 text-primary'
                    aria-hidden
                />
                <span className='truncate'>
                    {selected?.name ?? tr('chooseCollection')}
                </span>
                <ChevronDown
                    className='size-4 shrink-0 text-muted-foreground'
                    aria-hidden
                />
            </Button>
            {open && (
                <CatalogDialog
                    title={tr('pickerTitle')}
                    description={tr('pickerHint')}
                    onClose={() => setOpen(false)}
                >
                    <CatalogSearch
                        value={page.query}
                        onChange={page.search}
                        label={tr('searchCollections')}
                    />
                    <CatalogQueryState query={query} />
                    {data && (
                        <>
                            <ul className='max-h-[40dvh] space-y-2 overflow-y-auto'>
                                {data.items.map((item) => (
                                    <li key={item.id}>
                                        <Button
                                            type='button'
                                            variant={
                                                selected?.id === item.id
                                                    ? 'secondary'
                                                    : 'ghost'
                                            }
                                            aria-pressed={
                                                selected?.id === item.id
                                            }
                                            disabled={!item.permissions.read}
                                            className='h-auto w-full justify-start gap-3 whitespace-normal p-3 text-left'
                                            onClick={() => {
                                                if (!item.permissions.read)
                                                    return;
                                                setOpen(false);
                                                onSelect({
                                                    id: item.id,
                                                    name: item.name,
                                                });
                                            }}
                                        >
                                            <Database
                                                className='size-4 shrink-0 text-primary'
                                                aria-hidden
                                            />
                                            <span className='min-w-0 flex-1 space-y-1'>
                                                <span className='block break-words font-medium'>
                                                    {item.name}
                                                </span>
                                                <span className='block break-words text-xs font-normal text-muted-foreground'>
                                                    {
                                                        item.configuration
                                                            .provider
                                                    }{' '}
                                                    · {item.configuration.model}
                                                </span>
                                                {!item.permissions.read && (
                                                    <span className='block text-xs font-normal text-muted-foreground'>
                                                        {tr('readRequired')}
                                                    </span>
                                                )}
                                            </span>
                                            {selected?.id === item.id && (
                                                <Check
                                                    className='size-4 shrink-0'
                                                    aria-hidden
                                                />
                                            )}
                                        </Button>
                                    </li>
                                ))}
                                {data.total === 0 && (
                                    <li className='p-5 text-center text-sm text-muted-foreground'>
                                        {tr(
                                            page.query
                                                ? 'noMatches'
                                                : 'noCollections'
                                        )}
                                    </li>
                                )}
                            </ul>
                            <CatalogPagination
                                offset={page.offset}
                                total={data.total}
                                limit={page.limit}
                                onChange={page.setOffset}
                            />
                        </>
                    )}
                    <div className='flex justify-end'>
                        <Button
                            type='button'
                            variant='outline'
                            onClick={() => setOpen(false)}
                        >
                            {common('close')}
                        </Button>
                    </div>
                </CatalogDialog>
            )}
        </>
    );
}
