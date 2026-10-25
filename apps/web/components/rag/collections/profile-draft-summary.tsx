'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { Layers3, Sparkles } from 'lucide-react';
import type { ProfileDraft } from './profile-draft';

export function ProfileDraftSummary({
    draft,
    recommended = false,
    detailed = false,
}: Readonly<{
    draft: ProfileDraft;
    recommended?: boolean;
    detailed?: boolean;
}>) {
    const tr = useTranslations('rag');
    const format = useFormatter();
    const strategy = {
        DOCUMENT_STRUCTURE: 'profile.structure',
        TOKEN_WINDOW: 'profile.tokens',
        SEMANTIC: 'profile.semantic',
    } as const;
    const fields = [
        [tr('profile.dimensions'), format.number(Number(draft.dimensions))],
        [tr('profile.index'), draft.indexType],
        [tr('profile.chunking'), tr(strategy[draft.chunkingStrategy])],
        [
            tr('profile.targetOverlap'),
            tr('profile.tokenPair', {
                first: Number(draft.targetTokens),
                second: Number(draft.overlapTokens),
            }),
        ],
        [
            tr('indexing.preset'),
            tr(`indexing.presets.${draft.embeddingPreset}`),
        ],
        [
            tr('profile.parentChildSummary'),
            tr(draft.parentChild ? 'common.enabled' : 'common.disabled'),
        ],
    ];
    return (
        <section className='overflow-hidden rounded-xl border border-info/20 bg-info/5'>
            <div className='flex items-center gap-2 border-b border-info/15 px-4 py-3 text-sm font-semibold text-info'>
                {recommended ? (
                    <Sparkles className='size-4' aria-hidden />
                ) : (
                    <Layers3 className='size-4' aria-hidden />
                )}
                {tr(recommended ? 'editor.recommended' : 'editor.summary')}
            </div>
            <dl className='grid grid-cols-2 gap-4 p-4 sm:grid-cols-3'>
                {fields.map(([label, value]) => (
                    <div key={label} className='min-w-0'>
                        <dt className='text-xs text-muted-foreground'>
                            {label}
                        </dt>
                        <dd className='mt-1 break-words text-sm font-semibold'>
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
            <details
                open={detailed || undefined}
                className='border-t border-info/15 px-4 py-3 text-sm'
            >
                <summary className='cursor-pointer font-medium text-info'>
                    {tr('editor.allSettings')}
                </summary>
                <dl className='mt-3 grid gap-3 sm:grid-cols-2'>
                    <div>
                        <dt className='text-xs text-muted-foreground'>
                            {tr('profile.bounds')}
                        </dt>
                        <dd className='mt-1'>
                            {tr('profile.tokenPair', {
                                first: Number(draft.minTokens),
                                second: Number(draft.maxTokens),
                            })}
                        </dd>
                    </div>
                    {draft.chunkingStrategy === 'SEMANTIC' && (
                        <div>
                            <dt className='text-xs text-muted-foreground'>
                                {tr('profile.percentile')}
                            </dt>
                            <dd className='mt-1'>
                                {tr('profile.percentileValue', {
                                    value: Number(draft.semanticPercentile),
                                })}
                            </dd>
                        </div>
                    )}
                    {draft.parentChild && (
                        <div>
                            <dt className='text-xs text-muted-foreground'>
                                {tr('profile.parentMaximum')}
                            </dt>
                            <dd className='mt-1'>
                                {tr('profile.tokenCount', {
                                    count: Number(draft.parentMaxTokens),
                                })}
                            </dd>
                        </div>
                    )}
                    <div className='min-w-0 sm:col-span-2'>
                        <dt className='text-xs text-muted-foreground'>
                            {tr('profile.preparationSummary')}
                        </dt>
                        <dd className='mt-1 max-h-24 overflow-y-auto whitespace-pre-wrap break-words'>
                            {draft.preparation || tr('editor.noPreparation')}
                        </dd>
                    </div>
                    <div className='sm:col-span-2'>
                        <dt className='text-xs text-muted-foreground'>
                            {tr('indexing.metadataFields')}
                        </dt>
                        <dd className='mt-1'>
                            {draft.metadataRows.length ? (
                                <ul className='flex flex-wrap gap-2'>
                                    {draft.metadataRows.map((row) => (
                                        <li
                                            key={row.id}
                                            className='rounded-md border px-2 py-1 text-xs'
                                        >
                                            {row.key} ·{' '}
                                            {tr(
                                                `indexing.fieldTypes.${row.type}`
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                tr('editor.noMetadata')
                            )}
                        </dd>
                    </div>
                </dl>
            </details>
            <p className='border-t border-info/15 px-4 py-3 text-xs text-muted-foreground'>
                {tr('editor.fixedSettings')}
            </p>
        </section>
    );
}
