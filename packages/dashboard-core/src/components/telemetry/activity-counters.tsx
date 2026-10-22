'use client';
import {
    activityNumber,
    executionCounters,
    nativeCounters,
    type ActivityCounters,
    type ActivityFormatting,
} from './types';

/** Unknown observations are never converted to zero or added to quota-ledger usage. */
export function ActivityCounterList({
    counters,
    keys,
    locale,
    text,
}: Readonly<{
    counters: ActivityCounters;
    keys: readonly (keyof ActivityCounters)[];
}> &
    Pick<ActivityFormatting, 'locale' | 'text'>) {
    return (
        <dl className='grid gap-4 sm:grid-cols-2 xl:grid-cols-3'>
            {keys.map((key) => (
                <div key={key} className='min-w-0'>
                    <dt className='text-sm text-muted-foreground'>
                        {text(`counters.${key}`)}
                    </dt>
                    <dd className='break-words font-medium tabular-nums'>
                        {counters[key] === null
                            ? text('unknown')
                            : activityNumber(counters[key], locale)}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

export function ActivityTotals({
    counters,
    ...formatting
}: Readonly<{ counters: ActivityCounters }> & ActivityFormatting) {
    return (
        <div className='space-y-5'>
            <ActivityCounterList
                counters={counters}
                keys={executionCounters}
                {...formatting}
            />
            <details className='space-y-4 rounded-lg border p-4'>
                <summary className='cursor-pointer font-medium'>
                    {formatting.text('nativeTitle')}
                </summary>
                <p className='text-sm text-muted-foreground'>
                    {formatting.text('nativeHint')}
                </p>
                <ActivityCounterList
                    counters={counters}
                    keys={nativeCounters}
                    {...formatting}
                />
            </details>
            <ActivityCounterList
                counters={counters}
                keys={['sourceReadBytes', 'artifactWrittenBytes']}
                {...formatting}
            />
            <p className='text-xs text-muted-foreground'>
                {formatting.text('ioHint')}
            </p>
        </div>
    );
}
