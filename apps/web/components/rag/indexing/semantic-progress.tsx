'use client';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { RagOutputs } from '../types';

type Progress = NonNullable<
    RagOutputs['indexing']['tasks']['items'][number]['semantic']
>;

/** Render bounded checkpoint metadata without converting PostgreSQL counters to imprecise numbers. */
export function SemanticProgress({
    progress,
}: Readonly<{ progress: Progress }>) {
    const tr = useTranslations('rag.semantic');
    const format = useFormatter();
    const locale = useLocale();
    const counter = (value: string) =>
        new Intl.NumberFormat(locale).format(BigInt(value));
    const tokens = (value: string | null) =>
        value === null ? tr('unknown') : counter(value);
    return (
        <div className='space-y-3 rounded-lg bg-muted p-3'>
            <p className='font-medium'>
                {tr('progress', {
                    completed: progress.completedUnits,
                    total: progress.unitCount,
                })}
            </p>
            {progress.unitCount > 0 && (
                <progress
                    className='h-2 w-full accent-primary'
                    max={progress.unitCount}
                    value={progress.completedUnits}
                    aria-label={tr('progressLabel')}
                />
            )}
            <p>{tr(progress.sealed ? 'sealed' : 'unsealed')}</p>
            <dl className='grid gap-3 sm:grid-cols-2'>
                {(
                    [
                        [
                            'continuations',
                            format.number(progress.continuations),
                        ],
                        [
                            'reservedPreparedBytes',
                            counter(progress.reservedPreparedBytes),
                        ],
                        [
                            'reservedBatches',
                            format.number(progress.reservedBatches),
                        ],
                        [
                            'confirmedBatches',
                            format.number(progress.confirmedBatches),
                        ],
                        [
                            'uncertainBatches',
                            format.number(progress.uncertainBatches),
                        ],
                        [
                            'estimatedInputTokens',
                            counter(progress.estimatedInputTokens),
                        ],
                        [
                            'providerInputTokens',
                            tokens(progress.providerInputTokens),
                        ],
                        [
                            'billedInputTokens',
                            progress.billedInputTokens === null
                                ? tr('unknown')
                                : format.number(progress.billedInputTokens, {
                                      maximumSignificantDigits: 15,
                                  }),
                        ],
                    ] as const
                ).map(([key, value]) => (
                    <div key={key}>
                        <dt className='text-muted-foreground'>{tr(key)}</dt>
                        <dd className='break-words'>{value}</dd>
                    </div>
                ))}
            </dl>
            <p className='text-xs text-muted-foreground'>{tr('taskHint')}</p>
        </div>
    );
}
