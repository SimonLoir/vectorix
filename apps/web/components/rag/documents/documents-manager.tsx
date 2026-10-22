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
    const query = useQuery({
        ...orpc.admin.rag.documents.list.queryOptions({
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
    return (
        <div className='space-y-5'>
            <div className='flex flex-wrap justify-between gap-3'>
                <CatalogSearch
                    value={page.query}
                    onChange={page.search}
                    label={tr('search')}
                />
                {canOperation('admin.rag.documents.upload') && (
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
                                href={`/dashboard/documents/${item.id}`}
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
                            <h2 className='font-medium'>{tr('empty')}</h2>
                            <p className='mt-2 text-sm text-muted-foreground'>
                                {tr('emptyHint')}
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
