'use client';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import {
    CatalogSearch,
    CatalogPagination,
    useCatalogPagination,
} from '../catalog-controls';
import { IndexQueryState } from './index-state';
import { sourcePosition } from './source-label';
import type { IndexChunk } from './types';

export function ChunkSources({ chunk }: Readonly<{ chunk: IndexChunk }>) {
    const tr = useTranslations('rag');
    return (
        <ul className='space-y-1 text-xs text-muted-foreground'>
            {chunk.sourceSpans.map((span, index) => (
                <li key={`${span.source.index}-${index}`}>
                    {sourcePosition(span.source, tr)}
                    {' · '}
                    {tr('indexing.sourceOffsets', {
                        start: span.start,
                        end: span.end,
                    })}
                </li>
            ))}
            {chunk.sourceSpansTruncated && (
                <li>{tr('indexing.moreSources')}</li>
            )}
        </ul>
    );
}
export function IndexChunks({
    collectionId,
}: Readonly<{ collectionId: string }>) {
    const tr = useTranslations('rag.indexing');
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const query = useQuery({
        ...orpc.admin.rag.indexing.chunks.queryOptions({
            input: {
                collectionId,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        retry: false,
        staleTime: 0,
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h3 className='font-semibold'>{tr('chunks')}</h3>
            <p className='text-sm text-muted-foreground'>{tr('chunksHint')}</p>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('chunkSearch')}
            />
            <IndexQueryState query={query} />
            {data && (
                <>
                    <ul className='space-y-4'>
                        {data.items.map((chunk) => (
                            <li
                                key={chunk.id}
                                className='space-y-3 rounded-lg border p-4'
                            >
                                <h4 className='font-medium break-words'>
                                    {chunk.documentName} ·{' '}
                                    {tr('version', { version: chunk.version })}
                                </h4>
                                <p className='text-xs text-muted-foreground'>
                                    {tr('chunkInfo', {
                                        ordinal: chunk.ordinal + 1,
                                        tokens: chunk.tokenCount,
                                        estimate: chunk.tokenCountIsEstimate
                                            ? 'yes'
                                            : 'no',
                                        published: chunk.published
                                            ? 'yes'
                                            : 'no',
                                    })}
                                </p>
                                <pre
                                    tabIndex={0}
                                    className='max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-sm'
                                >
                                    {chunk.text}
                                </pre>
                                <ChunkSources chunk={chunk} />
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
        </section>
    );
}
