'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { RequestErrorState } from '@/components/request-error-state';
import { ChunkSources } from './chunk-sources';

/** Resolve each selected child citation independently; its receipt retains the search's original expiration. */
export function SearchCitation({
    collectionId,
    receipt,
    active,
}: Readonly<{
    collectionId: string;
    receipt: string;
    active: boolean;
}>) {
    const tr = useTranslations('rag');
    const format = useFormatter();
    const { orpc } = useORPC();
    const query = useQuery({
        ...orpc.retrieval.citation.queryOptions({
            input: { collectionId, receipt },
        }),
        enabled: active,
        retry: false,
        staleTime: 0,
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section
            aria-label={tr('retrieval.citationTitle')}
            className='min-w-0 space-y-3 rounded-lg border p-3'
        >
            <h3 className='font-medium'>{tr('retrieval.citationTitle')}</h3>
            {query.isPending && <p role='status'>{tr('common.loading')}</p>}
            {query.isError && (
                <RequestErrorState
                    errorKey={requestErrorKey(query.error)}
                    onRetry={query.refetch}
                />
            )}
            {data && (
                <>
                    <p className='break-words text-sm'>
                        {data.documentName} ·{' '}
                        {tr('indexing.version', { version: data.version })} ·{' '}
                        {tr('retrieval.passageNumber', {
                            number: data.ordinal + 1,
                        })}
                    </p>
                    <ChunkSources chunk={data} />
                    <p className='text-xs text-muted-foreground'>
                        {tr('retrieval.expiresAt', {
                            date: format.dateTime(data.source.expiresAt, {
                                dateStyle: 'short',
                                timeStyle: 'short',
                            }),
                        })}
                    </p>
                    <details className='text-xs'>
                        <summary className='cursor-pointer font-medium'>
                            {tr('retrieval.identifiers')}
                        </summary>
                        <dl className='mt-2 grid min-w-0 gap-2 break-all'>
                            <div>
                                <dt className='text-muted-foreground'>
                                    {tr('retrieval.generation')}
                                </dt>
                                <dd>{data.generationId}</dd>
                            </div>
                            <div>
                                <dt className='text-muted-foreground'>
                                    {tr('retrieval.chunk')}
                                </dt>
                                <dd>{data.chunkId}</dd>
                            </div>
                        </dl>
                    </details>
                </>
            )}
        </section>
    );
}
