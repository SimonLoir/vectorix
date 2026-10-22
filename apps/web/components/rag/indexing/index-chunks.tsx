'use client';
import { useState } from 'react';
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
import { SelectField } from '../form-fields';
import type { IndexChunk, IndexStatus } from './types';

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
    status,
}: Readonly<{ collectionId: string; status: IndexStatus }>) {
    const tr = useTranslations('rag.indexing');
    const [selected, setSelected] = useState('active');
    const candidates = status.canManage
        ? status.generations.filter(
              (generation) =>
                  generation.id !== status.active?.id &&
                  ['PROVISIONING', 'BUILDING', 'FAILED'].includes(
                      generation.status
                  )
          )
        : [];
    const selectedCandidate = candidates.find(
        (generation) => generation.id === selected
    );
    const generation = selectedCandidate ?? status.active;
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h3 className='font-semibold'>{tr('chunks')}</h3>
            <p className='text-sm text-muted-foreground'>{tr('chunksHint')}</p>
            {status.canManage && candidates.length > 0 && (
                <SelectField
                    label={tr('rebuild.previewGeneration')}
                    value={selectedCandidate?.id ?? 'active'}
                    onChange={(event) => setSelected(event.currentTarget.value)}
                >
                    <option value='active'>
                        {tr('rebuild.activePreview', {
                            revision: status.active?.configurationRevision ?? 0,
                        })}
                    </option>
                    {candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                            {tr('rebuild.candidatePreview', {
                                revision: candidate.configurationRevision,
                                status: tr(
                                    `generationStatus.${candidate.status}`
                                ),
                                id: candidate.id,
                            })}
                        </option>
                    ))}
                </SelectField>
            )}
            {generation ? (
                <>
                    <p className='break-all text-xs text-muted-foreground'>
                        {tr('rebuild.generation', { id: generation.id })}
                    </p>
                    {selectedCandidate && (
                        <p
                            role='status'
                            className='rounded-lg border p-3 text-sm'
                        >
                            {tr('rebuild.previewOnly')}
                        </p>
                    )}
                    <GenerationChunks
                        key={generation.id}
                        collectionId={collectionId}
                        generation={generation}
                    />
                </>
            ) : (
                <p role='status'>{tr('searchNotReady')}</p>
            )}
        </section>
    );
}

/** Pin preview requests to one generation so an activation cannot silently mix the displayed chunks. */
function GenerationChunks({
    collectionId,
    generation,
}: Readonly<{
    collectionId: string;
    generation: IndexStatus['generations'][number];
}>) {
    const tr = useTranslations('rag.indexing');
    const { orpc } = useORPC();
    const page = useCatalogPagination();
    const options = orpc.admin.rag.indexing.chunks.queryOptions({
        input: {
            collectionId,
            generationId: generation.id,
            query: page.query,
            offset: page.offset,
            limit: page.limit,
        },
    });
    const query = useQuery({
        ...options,
        queryKey: [
            ...options.queryKey,
            'generation',
            generation.id,
            generation.status,
        ],
        retry: false,
        staleTime: 0,
        refetchInterval: (query) =>
            query.state.error ||
            !['PROVISIONING', 'BUILDING'].includes(generation.status)
                ? false
                : 3000,
    });
    const data = query.isError ? undefined : query.data;
    return (
        <div className='space-y-4'>
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
                                    {tr('rebuild.generation', {
                                        id: chunk.generationId,
                                    })}
                                </p>
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
        </div>
    );
}
