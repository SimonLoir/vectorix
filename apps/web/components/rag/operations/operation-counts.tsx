'use client';
import { useFormatter, useTranslations } from 'next-intl';
import type { Operations } from './types';

const states = [
    'uploading',
    'due',
    'scheduled',
    'leased',
    'expired',
    'failed',
] as const;

export function OperationCounts({
    counts,
}: Readonly<{ counts: Operations['counts'] }>) {
    const tr = useTranslations('rag.operations');
    const format = useFormatter();
    return (
        <div className='grid gap-4 lg:grid-cols-3'>
            {counts.map((count) => (
                <section
                    key={count.category}
                    className='space-y-4 rounded-xl border bg-card p-5'
                >
                    <h2 className='font-semibold'>
                        {tr(`categories.${count.category}`)}
                    </h2>
                    <p className='text-2xl font-semibold'>
                        {tr('total', { count: count.total })}
                    </p>
                    <dl className='grid grid-cols-2 gap-3 text-sm'>
                        {states.map((state) => (
                            <div key={state}>
                                <dt className='text-muted-foreground'>
                                    {tr(`counts.${state}`)}
                                </dt>
                                <dd className='font-medium'>
                                    {format.number(count[state])}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <p className='text-xs text-muted-foreground'>
                        {count.oldestAcceptedAt
                            ? tr('oldestAccepted', {
                                  date: format.dateTime(
                                      count.oldestAcceptedAt,
                                      {
                                          dateStyle: 'medium',
                                          timeStyle: 'short',
                                      }
                                  ),
                              })
                            : tr('noAcceptedWork')}
                    </p>
                </section>
            ))}
        </div>
    );
}
