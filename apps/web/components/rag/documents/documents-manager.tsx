'use client';
import { useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { FileText, ArrowUpRight } from 'lucide-react';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import {
    CatalogSearch,
    CatalogPagination,
    useCatalogPagination,
} from '../catalog-controls';
import { DocumentQueryState } from './query-state';
import { DocumentUpload } from './document-upload';

export function DocumentsManager() {
    const tr = useTranslations('rag.documents');
    const format = useFormatter();
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const page = useCatalogPagination();
    const [uploading, setUploading] = useState(false);
    const [requestedDeleted, setDeleted] = useState(false);
    const deleted =
        requestedDeleted && canOperation('admin.rag.documents.trash');
    const activeQuery = useQuery({
        ...orpc.admin.rag.documents.list.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        enabled: !deleted,
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 5000),
    });
    const deletedQuery = useQuery({
        ...orpc.admin.rag.documents.trash.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        enabled: deleted && canOperation('admin.rag.documents.trash'),
        retry: false,
        staleTime: 0,
        refetchInterval: (entry) => (entry.state.error ? false : 5000),
    });
    const query = deleted ? deletedQuery : activeQuery;
    return (
        <div className='space-y-5'>
            {canOperation('admin.rag.documents.trash') && (
                <div
                    role='group'
                    aria-label={tr('lifecycle.libraryViews')}
                    className='flex gap-2'
                >
                    {[false, true].map((value) => (
                        <Button
                            key={String(value)}
                            aria-pressed={deleted === value}
                            variant={deleted === value ? 'default' : 'outline'}
                            onClick={() => {
                                setDeleted(value);
                                page.setOffset(0);
                            }}
                        >
                            {tr(
                                value
                                    ? 'lifecycle.deletedTab'
                                    : 'lifecycle.activeTab'
                            )}
                        </Button>
                    ))}
                </div>
            )}
            {deleted && (
                <p className='text-sm text-muted-foreground'>
                    {tr('lifecycle.deletedLibraryHint')}
                </p>
            )}
            <div className='flex flex-wrap justify-between gap-3'>
                <CatalogSearch
                    value={page.query}
                    onChange={page.search}
                    label={tr('search')}
                />
                {!deleted && canOperation('admin.rag.documents.upload') && (
                    <Button onClick={() => setUploading(true)}>
                        {tr('upload')}
                    </Button>
                )}
            </div>
            <DocumentQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <div className='grid gap-4 md:grid-cols-2 xl:grid-cols-3'>
                        {query.data.items.map((item) => (
                            <Link
                                key={item.id}
                                href={
                                    deleted
                                        ? `/dashboard/documents/deleted/${item.id}`
                                        : `/dashboard/documents/${item.id}`
                                }
                                className='space-y-4 rounded-xl border bg-card p-5 hover:border-primary focus-visible:outline-2 focus-visible:outline-primary'
                            >
                                <div className='flex justify-between'>
                                    <FileText className='size-5 text-muted-foreground' />
                                    <ArrowUpRight className='size-4' />
                                </div>
                                <h2 className='break-words text-lg font-semibold'>
                                    {item.name}
                                </h2>
                                <Badge variant='secondary'>
                                    {tr(`status.${item.status}`)}
                                </Badge>
                                <p className='text-sm text-muted-foreground'>
                                    {format.dateTime(item.createdAt, {
                                        dateStyle: 'medium',
                                        timeStyle: 'short',
                                    })}
                                </p>
                            </Link>
                        ))}
                    </div>
                    {query.data.total === 0 && (
                        <div className='rounded-xl border border-dashed p-10 text-center'>
                            <h2 className='font-medium'>
                                {tr(
                                    deleted ? 'lifecycle.deletedEmpty' : 'empty'
                                )}
                            </h2>
                            <p className='mt-2 text-sm text-muted-foreground'>
                                {tr(
                                    deleted
                                        ? 'lifecycle.deletedEmptyHint'
                                        : 'emptyHint'
                                )}
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
            {uploading && (
                <DocumentUpload onClose={() => setUploading(false)} />
            )}
        </div>
    );
}
