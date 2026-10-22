'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronDown } from 'lucide-react';
import { Button } from '@repo/ui/button';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@repo/ui/collapsible';
import { ChunkSources } from './chunk-sources';
import type { IndexChunk } from './types';

/** Keep the ranked child visible; parent context never replaces its identity or exact-version receipt. */
export function ChunkContent({ chunk }: Readonly<{ chunk: IndexChunk }>) {
    const tr = useTranslations('rag.indexing');
    return (
        <div className='min-w-0 space-y-3'>
            {chunk.parentContext && (
                <p className='text-sm font-medium'>{tr('matchedPassage')}</p>
            )}
            {typeof chunk.startOffset === 'number' &&
                typeof chunk.endOffset === 'number' && (
                    <p className='text-xs text-muted-foreground'>
                        {tr('sourceOffsets', {
                            start: chunk.startOffset,
                            end: chunk.endOffset,
                        })}
                    </p>
                )}
            <pre
                tabIndex={0}
                aria-label={tr('matchedPassage')}
                className='max-h-72 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm'
            >
                {chunk.text}
            </pre>
            <ChunkSources chunk={chunk} />
            {chunk.parentContext && (
                <ParentContext context={chunk.parentContext} />
            )}
        </div>
    );
}

function ParentContext({
    context,
}: Readonly<{ context: NonNullable<IndexChunk['parentContext']> }>) {
    const tr = useTranslations('rag.indexing');
    const [expanded, setExpanded] = useState(false);
    return (
        <Collapsible
            open={expanded}
            onOpenChange={setExpanded}
            className='space-y-3 rounded-lg border p-3'
        >
            <CollapsibleTrigger asChild>
                <Button
                    type='button'
                    variant='ghost'
                    className='group h-auto w-full justify-between gap-3 whitespace-normal text-left'
                >
                    {tr('parentContextToggle', {
                        expanded: expanded ? 'yes' : 'no',
                    })}
                    <ChevronDown
                        aria-hidden='true'
                        className='size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180'
                    />
                </Button>
            </CollapsibleTrigger>
            <CollapsibleContent
                role='region'
                aria-label={tr('parentContextTitle')}
                className='space-y-3'
            >
                <p className='text-xs text-muted-foreground'>
                    {tr('parentContextInfo', {
                        tokens: context.tokenCount,
                        estimate: context.tokenCountIsEstimate ? 'yes' : 'no',
                        start: context.startOffset,
                        end: context.endOffset,
                    })}
                </p>
                <pre
                    tabIndex={0}
                    aria-label={tr('parentContextTitle')}
                    className='max-h-96 overflow-auto overscroll-contain whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-sm'
                >
                    {context.text}
                </pre>
                <ChunkSources chunk={context} />
                <p className='text-xs text-muted-foreground'>
                    {tr('parentContextSourceHint')}
                </p>
            </CollapsibleContent>
        </Collapsible>
    );
}
