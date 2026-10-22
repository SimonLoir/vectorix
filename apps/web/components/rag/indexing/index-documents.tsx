'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import {
    CatalogSearch,
    CatalogPagination,
    useCatalogPagination,
} from '../catalog-controls';
import { IndexQueryState } from './index-state';
import { DocumentMetadata } from './document-metadata';
import type { IndexDocument, MetadataFields } from './types';

export function IndexDocuments({
    collectionId,
    fields,
    canManage,
}: Readonly<{
    collectionId: string;
    fields: MetadataFields;
    canManage: boolean;
}>) {
    const tr = useTranslations('rag.indexing');
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const [editing, setEditing] = useState<IndexDocument | null>(null);
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
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 3000),
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h3 className='font-semibold'>{tr('documents')}</h3>
            <p className='text-sm text-muted-foreground'>
                {tr('documentsHint')}
            </p>
            <Link href='/dashboard/documents' className='text-sm underline'>
                {tr('openLibrary')}
            </Link>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('documentSearch')}
            />
            <IndexQueryState query={query} />
            {data && (
                <>
                    <ul className='space-y-3'>
                        {data.items.map((item) => (
                            <li
                                key={item.documentId}
                                className='space-y-2 rounded-lg border p-4 text-sm'
                            >
                                <p className='break-words font-medium'>
                                    {item.name}
                                </p>
                                <p>
                                    {tr('documentVersions', {
                                        library: item.libraryVersion ?? 0,
                                        indexed: item.indexedVersion ?? 0,
                                    })}
                                </p>
                                <p>
                                    {tr(`languages.${item.language}`)}
                                    {item.tags.length > 0 &&
                                        ` · ${item.tags.join(', ')}`}
                                </p>
                                {item.pending && (
                                    <p role='status'>{tr('documentPending')}</p>
                                )}
                                {item.errorCode && (
                                    <p role='alert'>
                                        {tr(`errors.${item.errorCode}`)}
                                    </p>
                                )}
                                {canManage &&
                                    canOperation(
                                        'admin.rag.indexing.updateMetadata'
                                    ) && (
                                        <Button
                                            size='sm'
                                            variant='outline'
                                            onClick={() => setEditing(item)}
                                        >
                                            {tr('editMetadata')}
                                        </Button>
                                    )}
                            </li>
                        ))}
                    </ul>
                    <CatalogPagination
                        offset={page.offset}
                        total={data.total}
                        limit={page.limit}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {editing && (
                <DocumentMetadata
                    collectionId={collectionId}
                    document={editing}
                    fields={fields}
                    onClose={() => setEditing(null)}
                />
            )}
        </section>
    );
}
