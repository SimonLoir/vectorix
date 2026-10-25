'use client';
import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { useIndexAction } from './index-state';
import { SearchForm } from './search-form';
import { filtersFromForm } from './search-filters';
import { SearchResults } from './search-results';
import { SearchSource } from './search-source';
import type { MetadataFields, SearchResponse, SearchResult } from './types';

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
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const [response, setResponse] = useState<SearchResponse | null>(null);
    const [source, setSource] = useState<SearchResult | null>(null);
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
                busy={action.busy}
                error={action.error}
                presentation={presentation}
                query={query}
                onQueryChange={onQueryChange}
                collectionControl={collectionControl}
                onSubmit={(event) => {
                    event.preventDefault();
                    if (
                        !collectionId ||
                        !ready ||
                        !canOperation('admin.rag.indexing.search')
                    )
                        return;
                    const data = new FormData(event.currentTarget);
                    setResponse(null);
                    setSource(null);
                    void action.run(
                        () => {
                            const strategy = data.get('strategy');
                            if (
                                strategy !== 'HYBRID' &&
                                strategy !== 'LEXICAL' &&
                                strategy !== 'VECTOR'
                            )
                                throw new Error('Invalid strategy.');
                            return client.admin.rag.indexing.search({
                                collectionId,
                                query: String(data.get('query')),
                                strategy,
                                topK: Number(data.get('topK')),
                                filters: filtersFromForm(data, fields),
                            });
                        },
                        setResponse,
                        false
                    );
                }}
            />
            {readinessMessage}
            {response && (
                <SearchResults
                    response={response}
                    activeGenerationId={activeGenerationId}
                    onOpenSource={setSource}
                />
            )}
            {source && canOperation('admin.rag.indexing.sourcePreview') && (
                <SearchSource
                    collectionId={collectionId}
                    result={source}
                    onClose={() => setSource(null)}
                />
            )}
        </section>
    );
}
