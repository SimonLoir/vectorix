'use client';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { RagOutputs } from './types';

type Semantic = NonNullable<RagOutputs['quota']['semantic']>;
const counters = [
    'storedPlanBytes',
    'reservedPlanBytes',
    'reservedPreparedBytes',
    'reservedBatches',
    'dispatchedPreparedBytes',
    'dispatchedBatches',
    'confirmedRequests',
    'estimatedInputTokens',
    'providerInputTokens',
    'unknownProviderTokenBatches',
    'unknownBilledTokenBatches',
    'uncertainAttempts',
] as const;

/** Show semantic work separately from legacy storage/chunk quotas and untracked historical calls. */
export function SemanticQuotaOverview({
    semantic,
}: Readonly<{ semantic: Semantic }>) {
    const tr = useTranslations('rag.semantic');
    const format = useFormatter();
    const locale = useLocale();
    const counter = (value: string | null) =>
        value === null
            ? tr('unknown')
            : new Intl.NumberFormat(locale).format(BigInt(value));
    return (
        <section className='space-y-4 rounded-xl border p-6'>
            <h2 className='font-semibold'>{tr('title')}</h2>
            <p className='text-sm text-muted-foreground'>{tr('scope')}</p>
            <p className='text-sm'>
                {semantic.usage.trackingSince
                    ? tr('trackingSince', {
                          date: format.dateTime(semantic.usage.trackingSince, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                          }),
                      })
                    : tr('notTracked')}
            </p>
            <dl className='grid gap-4 sm:grid-cols-2 lg:grid-cols-3'>
                {counters.map((key) => (
                    <div key={key}>
                        <dt className='text-sm text-muted-foreground'>
                            {tr(key)}
                        </dt>
                        <dd className='break-words font-medium'>
                            {counter(semantic.usage[key])}
                        </dd>
                    </div>
                ))}
                <div>
                    <dt className='text-sm text-muted-foreground'>
                        {tr('billedInputTokens')}
                    </dt>
                    <dd>
                        {semantic.usage.billedInputTokens === null
                            ? tr('unknown')
                            : format.number(semantic.usage.billedInputTokens, {
                                  maximumSignificantDigits: 15,
                              })}
                    </dd>
                </div>
            </dl>
            <p className='text-sm text-muted-foreground'>{tr('usageHint')}</p>
            <details className='space-y-4 rounded-lg border p-4'>
                <summary className='cursor-pointer font-medium'>
                    {tr('limitsTitle')}
                </summary>
                <dl className='grid gap-4 pt-3 sm:grid-cols-2'>
                    {Object.entries(semantic.limits).map(([key, value]) => (
                        <div key={key}>
                            <dt className='text-sm text-muted-foreground'>
                                {tr(key)}
                            </dt>
                            <dd>{format.number(value)}</dd>
                        </div>
                    ))}
                </dl>
                <p className='text-sm text-muted-foreground'>
                    {tr('limitsHint')}
                </p>
            </details>
        </section>
    );
}
