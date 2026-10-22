'use client';
import { useTranslations } from 'next-intl';
import { sourcePosition } from './source-label';
import type { IndexChunk } from './types';

/** Both child and parent projections are bounded by the public contract. */
export function ChunkSources({
    chunk,
}: Readonly<{
    chunk: Pick<IndexChunk, 'sourceSpans' | 'sourceSpansTruncated'>;
}>) {
    const tr = useTranslations('rag');
    return (
        <ul
            tabIndex={0}
            aria-label={tr('indexing.sourcePositions')}
            className='max-h-40 space-y-1 overflow-auto overscroll-contain text-xs text-muted-foreground'
        >
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
