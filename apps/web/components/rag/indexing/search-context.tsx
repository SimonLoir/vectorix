'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { RequestErrorState } from '@/components/request-error-state';
import { SelectField } from '../form-fields';
import { SearchCitation } from './search-citation';
import { ChunkSources } from './chunk-sources';
import type { SearchResult } from './types';
import type { VectorixApiV1Outputs } from '@repo/api';

type ContextPassage =
    VectorixApiV1Outputs['retrieval']['context']['passages'][number];

/** Read bounded adjacent children from the ranked receipt, without issuing another search or provider call. */
export function SearchContext({
    collectionId,
    result,
    active,
}: Readonly<{
    collectionId: string;
    result: SearchResult;
    active: boolean;
}>) {
    const tr = useTranslations('rag.retrieval');
    const commonTr = useTranslations('rag.common');
    const { orpc } = useORPC();
    const [before, setBefore] = useState(1);
    const [after, setAfter] = useState(1);
    const [citationReceipt, setCitationReceipt] = useState(
        result.source.receipt
    );
    const query = useQuery({
        ...orpc.retrieval.context.queryOptions({
            input: {
                collectionId,
                receipt: result.source.receipt,
                before,
                after,
            },
        }),
        enabled: active,
        retry: false,
        staleTime: 0,
    });
    const data = query.isError ? undefined : query.data;
    return (
        <div className='min-w-0 space-y-4'>
            <p className='text-sm text-muted-foreground'>{tr('contextHint')}</p>
            <div className='grid grid-cols-2 gap-3'>
                <NeighborCount
                    label={tr('before')}
                    value={before}
                    onChange={(value) => {
                        setBefore(value);
                        setCitationReceipt(result.source.receipt);
                    }}
                />
                <NeighborCount
                    label={tr('after')}
                    value={after}
                    onChange={(value) => {
                        setAfter(value);
                        setCitationReceipt(result.source.receipt);
                    }}
                />
            </div>
            {query.isError && (
                <>
                    <RequestErrorState
                        errorKey={requestErrorKey(query.error)}
                        onRetry={query.refetch}
                    />
                    <p className='text-sm text-muted-foreground'>
                        {tr('receiptHint')}
                    </p>
                </>
            )}
            {query.isPending && <p role='status'>{commonTr('loading')}</p>}
            {data && (
                <>
                    <p role='status' className='text-sm'>
                        {tr('contextSummary', {
                            count: data.passages.length,
                            version: data.version,
                        })}
                    </p>
                    <ol
                        tabIndex={0}
                        aria-label={tr('contextList')}
                        className='max-h-[45dvh] space-y-3 overflow-y-auto overscroll-contain pr-2'
                    >
                        {data.passages.map((passage) => (
                            <ContextPassageCard
                                key={passage.chunkId}
                                passage={passage}
                                selected={
                                    citationReceipt === passage.source.receipt
                                }
                                onCitation={() =>
                                    setCitationReceipt(passage.source.receipt)
                                }
                            />
                        ))}
                    </ol>
                    <SearchCitation
                        collectionId={collectionId}
                        receipt={citationReceipt}
                        active={active}
                    />
                </>
            )}
        </div>
    );
}

function NeighborCount({
    label,
    value,
    onChange,
}: Readonly<{
    label: string;
    value: number;
    onChange: (value: number) => void;
}>) {
    const tr = useTranslations('rag.retrieval');
    return (
        <SelectField
            label={label}
            value={value}
            onChange={(event) => onChange(Number(event.target.value))}
        >
            {[0, 1, 2].map((count) => (
                <option key={count} value={count}>
                    {tr('countOption', { count })}
                </option>
            ))}
        </SelectField>
    );
}

function ContextPassageCard({
    passage,
    selected,
    onCitation,
}: Readonly<{
    passage: ContextPassage;
    selected: boolean;
    onCitation: () => void;
}>) {
    const tr = useTranslations('rag.retrieval');
    const indexTr = useTranslations('rag.indexing');
    return (
        <li
            aria-current={passage.relation === 'MATCH' ? 'true' : undefined}
            className={
                passage.relation === 'MATCH'
                    ? 'min-w-0 space-y-3 rounded-lg border border-primary/30 bg-primary/5 p-3'
                    : 'min-w-0 space-y-3 rounded-lg border p-3'
            }
        >
            <h3 className='font-medium'>
                {tr(`relations.${passage.relation}`)} ·{' '}
                {tr('passageNumber', { number: passage.ordinal + 1 })}
            </h3>
            {passage.startOffset !== null && passage.endOffset !== null && (
                <p className='text-xs text-muted-foreground'>
                    {indexTr('sourceOffsets', {
                        start: passage.startOffset,
                        end: passage.endOffset,
                    })}
                </p>
            )}
            <pre className='whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm'>
                {passage.text}
            </pre>
            <ChunkSources chunk={passage} />
            <Button
                type='button'
                variant={selected ? 'secondary' : 'outline'}
                aria-pressed={selected}
                onClick={onCitation}
            >
                {selected ? tr('selectedCitation') : tr('inspectCitation')}
            </Button>
        </li>
    );
}
