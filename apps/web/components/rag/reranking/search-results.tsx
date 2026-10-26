'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/tabs';
import { SearchResults } from '../indexing/search-results';
import type { SearchResult } from '../indexing/types';
import type { RerankedSearchResponse } from './types';

/** Compare two orders of one bounded candidate pool while retaining each exact source receipt. */
export function RerankedSearchResults({
    response,
    activeGenerationId,
    onOpenSource,
}: Readonly<{
    response: RerankedSearchResponse;
    activeGenerationId: string | null;
    onOpenSource: (result: SearchResult) => void;
}>) {
    const tr = useTranslations('rag.reranking');
    const format = useFormatter();
    const run = response.reranking;
    const units = [
        { label: 'providerInputTokens', value: run.usage.providerInputTokens },
        { label: 'billedInputTokens', value: run.usage.billedInputTokens },
        { label: 'billedSearchUnits', value: run.usage.billedSearchUnits },
    ] as const;
    const results = (
        <SearchResults
            response={response}
            activeGenerationId={activeGenerationId}
            onOpenSource={onOpenSource}
        />
    );
    return (
        <section className='space-y-4'>
            <div className='space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4'>
                <h3 className='font-semibold'>
                    {tr('runTitle', {
                        provider: run.provider,
                        model: run.model,
                    })}
                </h3>
                <p className='text-sm'>
                    {tr('runSummary', {
                        candidates: run.candidateCount,
                        reranked: run.rerankedCount,
                        limit: run.candidateLimit,
                        duration: format.number(run.durationMs, {
                            maximumFractionDigits: 0,
                        }),
                    })}
                </p>
                {run.underfilled && (
                    <p role='status' className='text-sm'>
                        {tr('underfilled')}
                    </p>
                )}
                <p className='text-xs text-muted-foreground'>
                    {tr('scoreHint')}
                </p>
                <details>
                    <summary className='cursor-pointer text-sm font-medium'>
                        {tr('usage')}
                    </summary>
                    <dl className='mt-3 grid gap-3 text-sm sm:grid-cols-3'>
                        {units.map((unit) => (
                            <div key={unit.label}>
                                <dt className='text-muted-foreground'>
                                    {tr(unit.label)}
                                </dt>
                                <dd className='mt-1 font-medium'>
                                    {unit.value === null
                                        ? tr('unknown')
                                        : format.number(unit.value)}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className='mt-3 text-xs text-muted-foreground'>
                        {tr('usageHint')}
                    </p>
                </details>
            </div>
            {response.comparison ? (
                <Tabs defaultValue='reranked' className='gap-4'>
                    <TabsList
                        aria-label={tr('comparison')}
                        className='h-auto max-w-full flex-wrap'
                    >
                        <TabsTrigger value='reranked'>
                            {tr('rerankedOrder')}
                        </TabsTrigger>
                        <TabsTrigger value='original'>
                            {tr('originalOrder')}
                        </TabsTrigger>
                    </TabsList>
                    <p className='text-xs text-muted-foreground'>
                        {tr('comparisonHint')}
                    </p>
                    <TabsContent value='reranked'>{results}</TabsContent>
                    <TabsContent value='original'>
                        <SearchResults
                            response={response.comparison}
                            activeGenerationId={activeGenerationId}
                            onOpenSource={onOpenSource}
                        />
                    </TabsContent>
                </Tabs>
            ) : (
                results
            )}
        </section>
    );
}
