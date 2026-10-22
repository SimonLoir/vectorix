'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { CheckField } from '../form-fields';
import {
    CatalogSearch,
    CatalogPagination,
    useCatalogPagination,
} from '../catalog-controls';
import { IndexQueryState } from './index-state';

export function SearchDocumentFilter({
    collectionId,
}: Readonly<{ collectionId: string }>) {
    const tr = useTranslations('rag.indexing');
    const { orpc } = useORPC();
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState<Record<string, string>>({});
    const page = useCatalogPagination();
    const query = useQuery({
        ...orpc.admin.rag.indexing.documents.queryOptions({
            input: {
                collectionId,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        enabled: open,
        retry: false,
        staleTime: 0,
    });
    const data = query.isError ? undefined : query.data;
    return (
        <details
            className='space-y-3 rounded-lg border p-4'
            onToggle={(event) => setOpen(event.currentTarget.open)}
        >
            <summary className='cursor-pointer font-medium'>
                {tr('filterDocuments', { count: Object.keys(selected).length })}
            </summary>
            <input
                type='hidden'
                name='documentIds'
                value={JSON.stringify(Object.keys(selected))}
            />
            {Object.entries(selected).map(([id, name]) => (
                <Button
                    key={id}
                    type='button'
                    variant='outline'
                    size='sm'
                    className='mr-2 max-w-full'
                    aria-label={tr('removeDocumentFilter', { name })}
                    onClick={() =>
                        setSelected((previous) => {
                            const next = { ...previous };
                            delete next[id];
                            return next;
                        })
                    }
                >
                    <span className='truncate'>{name}</span> ×
                </Button>
            ))}
            {open && (
                <>
                    <CatalogSearch
                        value={page.query}
                        onChange={page.search}
                        label={tr('documentSearch')}
                    />
                    <IndexQueryState query={query} />
                    {data && (
                        <>
                            <div className='max-h-64 space-y-3 overflow-auto'>
                                {data.items.map((item) => (
                                    <CheckField
                                        key={item.documentId}
                                        label={item.name}
                                        checked={Boolean(
                                            selected[item.documentId]
                                        )}
                                        disabled={
                                            !selected[item.documentId] &&
                                            Object.keys(selected).length >= 100
                                        }
                                        onChange={(event) =>
                                            setSelected((previous) => {
                                                const next = { ...previous };
                                                if (event.target.checked)
                                                    next[item.documentId] =
                                                        item.name;
                                                else
                                                    delete next[
                                                        item.documentId
                                                    ];
                                                return next;
                                            })
                                        }
                                    />
                                ))}
                            </div>
                            <CatalogPagination
                                offset={page.offset}
                                total={data.total}
                                limit={page.limit}
                                onChange={page.setOffset}
                            />
                        </>
                    )}
                </>
            )}
        </details>
    );
}
