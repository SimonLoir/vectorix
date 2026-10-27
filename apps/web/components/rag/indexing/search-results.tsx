'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { ChunkContent } from './chunk-content';
import type { RerankedSearchResponse } from '../reranking/types';
import type { SearchResponse } from './types';
import type { OpenSearchSource } from './search-source';

/** Preserve serving-generation labels and exact-version receipts for every result. */
export function SearchResults({
    response,
    activeGenerationId,
    onOpenSource,
}: Readonly<{
    response: SearchResponse | RerankedSearchResponse;
    activeGenerationId: string | null;
    onOpenSource: OpenSearchSource;
}>) {
    const tr = useTranslations('rag.indexing');
    const retrievalTr = useTranslations('rag.retrieval');
    const format = useFormatter();
    const rerankTr = useTranslations('rag.reranking');
    const { canOperation } = useVectorixPermissions();
    return (
        <div className='space-y-4' aria-live='polite'>
            <p className='break-all text-xs text-muted-foreground'>
                {tr('rebuild.resultGeneration', {
                    id: response.generationId,
                    model: response.model,
                })}
            </p>
            {response.generationId !== activeGenerationId && (
                <p role='status' className='rounded-lg border p-3 text-sm'>
                    {tr('rebuild.previousResults')}
                </p>
            )}
            <p className='text-sm'>
                {tr('searchSummary', {
                    count: response.results.length,
                    duration: format.number(response.durationMs, {
                        maximumFractionDigits: 0,
                    }),
                    strategy: tr(`strategies.${response.strategy}`),
                })}
            </p>
            {response.vectorUnderfilled && (
                <p role='status' className='rounded-lg border p-3 text-sm'>
                    {tr('underfilled')}
                </p>
            )}
            {response.parentUnderfilled && (
                <p role='status' className='rounded-lg border p-3 text-sm'>
                    {tr('parentUnderfilled')}
                </p>
            )}
            {response.results.some((result) => result.parentContext) && (
                <p className='text-sm text-muted-foreground'>
                    {tr('parentSearchHint')}
                </p>
            )}
            {response.results.length === 0 && <p>{tr('noResults')}</p>}
            <ol className='space-y-4'>
                {response.results.map((result, index) => (
                    <li
                        key={result.id}
                        className='space-y-3 rounded-lg border p-4'
                    >
                        <h4 className='break-words font-medium'>
                            {tr('resultTitle', {
                                rank: index + 1,
                                name: result.documentName,
                                version: result.version,
                            })}
                        </h4>
                        <ChunkContent chunk={result} />
                        <p className='text-xs text-muted-foreground'>
                            {tr('scores', {
                                lexical: result.scores.lexicalRank ?? 0,
                                vector: result.scores.vectorRank ?? 0,
                                rrf: format.number(result.scores.rrf, {
                                    maximumFractionDigits: 5,
                                }),
                            })}
                        </p>
                        {'rerankScore' in result &&
                            typeof result.rerankScore === 'number' && (
                                <p className='text-sm font-medium text-primary dark:text-accent-foreground'>
                                    {rerankTr('score', {
                                        score: format.number(
                                            result.rerankScore,
                                            { maximumFractionDigits: 5 }
                                        ),
                                    })}
                                </p>
                            )}
                        <div className='flex flex-wrap gap-2'>
                            {canOperation(
                                'admin.rag.indexing.sourcePreview'
                            ) && (
                                <Button
                                    variant='outline'
                                    type='button'
                                    onClick={() =>
                                        onOpenSource(result, 'source')
                                    }
                                >
                                    {tr('openSource')}
                                </Button>
                            )}
                            {canOperation('retrieval.context') &&
                                canOperation('retrieval.citation') && (
                                    <Button
                                        variant='outline'
                                        type='button'
                                        onClick={() =>
                                            onOpenSource(result, 'context')
                                        }
                                    >
                                        {retrievalTr('openContext')}
                                    </Button>
                                )}
                        </div>
                    </li>
                ))}
            </ol>
        </div>
    );
}
