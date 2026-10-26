'use client';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useRerankProfile } from '../reranking/use-rerank-profile';
import { RerankSearchOptions } from '../reranking/search-options';
import { RerankedSearchResults } from '../reranking/search-results';
import { SearchForm } from './search-form';
import { useSearchExecution } from './use-search-execution';
import { SearchResults } from './search-results';
import { SearchSource } from './search-source';
import type { MetadataFields } from './types';

/** Reuse the exact search/source protocol; callers remount this workspace when collection authority changes. */
export function SearchPlayground({
    collectionId,
    fields,
    ready,
    activeGenerationId,
    presentation = 'panel',
    query,
    onQueryChange,
    collectionControl,
    readinessMessage,
}: Readonly<{
    collectionId: string;
    fields: MetadataFields;
    ready: boolean;
    activeGenerationId: string | null;
    presentation?: 'panel' | 'home';
    query?: string;
    onQueryChange?: (query: string) => void;
    collectionControl?: ReactNode;
    readinessMessage?: ReactNode;
}>) {
    const tr = useTranslations('rag.indexing');
    const rerankTr = useTranslations('rag.reranking');
    const { canOperation } = useVectorixPermissions();
    const rerank = useRerankProfile(collectionId);
    const execution = useSearchExecution({
        collectionId,
        fields,
        ready,
        rerank,
    });
    return (
        <section
            className={
                presentation === 'home'
                    ? 'space-y-5'
                    : 'space-y-5 rounded-xl border p-5'
            }
        >
            {presentation === 'panel' && (
                <>
                    <h3 className='font-semibold'>{tr('playground')}</h3>
                    <p className='text-sm text-muted-foreground'>
                        {tr('playgroundHint')}
                    </p>
                </>
            )}
            {presentation === 'panel' && !ready && (
                <p role='status'>{tr('searchNotReady')}</p>
            )}
            <SearchForm
                key={activeGenerationId ?? 'none'}
                collectionId={collectionId}
                fields={fields}
                ready={ready}
                busy={execution.action.busy}
                error={execution.action.error}
                presentation={presentation}
                query={query}
                onQueryChange={onQueryChange}
                collectionControl={collectionControl}
                retrievalOptions={
                    collectionId ? (
                        <RerankSearchOptions
                            key={`${rerank.key}:${ready}:${execution.optionsResetToken}`}
                            availability={rerank.availability(ready)}
                            provider={rerank.profile?.configuration?.provider}
                            model={rerank.profile?.configuration?.model}
                        />
                    ) : undefined
                }
                onSubmit={execution.onSubmit}
            />
            {readinessMessage}
            {execution.resultsUnavailable && (
                <p role='status' className='rounded-lg border p-3 text-sm'>
                    {rerankTr('resultsUnavailable')}
                </p>
            )}
            {execution.response &&
                (execution.response.kind === 'reranked' ? (
                    <RerankedSearchResults
                        response={execution.response.value}
                        activeGenerationId={activeGenerationId}
                        onOpenSource={execution.openSource}
                    />
                ) : (
                    <SearchResults
                        response={execution.response.value}
                        activeGenerationId={activeGenerationId}
                        onOpenSource={execution.openSource}
                    />
                ))}
            {execution.source &&
                canOperation('admin.rag.indexing.sourcePreview') && (
                    <SearchSource
                        collectionId={collectionId}
                        result={execution.source}
                        onClose={execution.closeSource}
                    />
                )}
        </section>
    );
}
