'use client';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import type { VectorixApiV1Outputs } from '@repo/api';

type Usage =
    VectorixApiV1Outputs['superadmin']['organizations']['getSemanticQuota']['usage'];
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

/** Decimal BIGINT strings stay exact; missing native usage remains explicitly unknown. */
export function OrganizationSemanticUsage({
    usage,
}: Readonly<{ usage: Usage }>) {
    const tr = useTranslations('admin.semanticQuota');
    const format = useFormatter();
    const locale = useLocale();
    return (
        <section className='space-y-4 rounded-lg border p-4'>
            <h3 className='font-medium'>{tr('usageTitle')}</h3>
            <p className='text-sm'>
                {usage.trackingSince
                    ? tr('trackingSince', {
                          date: format.dateTime(usage.trackingSince, {
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
                        <dd className='break-words'>
                            {usage[key] === null
                                ? tr('unknown')
                                : new Intl.NumberFormat(locale).format(
                                      BigInt(usage[key])
                                  )}
                        </dd>
                    </div>
                ))}
                <div>
                    <dt className='text-sm text-muted-foreground'>
                        {tr('billedInputTokens')}
                    </dt>
                    <dd>
                        {usage.billedInputTokens === null
                            ? tr('unknown')
                            : format.number(usage.billedInputTokens, {
                                  maximumSignificantDigits: 15,
                              })}
                    </dd>
                </div>
            </dl>
            <p className='text-sm text-muted-foreground'>{tr('usageHint')}</p>
        </section>
    );
}
