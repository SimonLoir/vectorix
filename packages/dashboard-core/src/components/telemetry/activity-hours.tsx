'use client';
import { useState } from 'react';
import { Button } from '@repo/ui/button';
import {
    activityNumber,
    type ActivityFormatting,
    type ActivitySummary,
} from './types';

const columns = [
    'recordedStarts',
    'recordedSuccesses',
    'recordedFailures',
    'nativeValidatedBatches',
] as const;
const pageSize = 24;

/** Fixed-size hourly pages keep the 720-hour window accessible without a giant table. */
export function ActivityHours({
    hourly,
    locale,
    text,
    date,
}: Readonly<{ hourly: ActivitySummary['hourly'] }> & ActivityFormatting) {
    const [page, setPage] = useState(0);
    const newest = hourly.toSorted(
        (left, right) =>
            right.bucketStart.getTime() - left.bucketStart.getTime()
    );
    const pageCount = Math.max(1, Math.ceil(newest.length / pageSize));
    const currentPage = Math.min(page, pageCount - 1);
    const items = newest.slice(
        currentPage * pageSize,
        (currentPage + 1) * pageSize
    );
    return (
        <details className='space-y-4 rounded-lg border p-4'>
            <summary className='cursor-pointer font-medium'>
                {text('hourlyTitle')}
            </summary>
            <p className='text-sm text-muted-foreground'>
                {text('hourlyHint')}
            </p>
            <div
                className='max-h-[60vh] overflow-auto rounded-md border'
                tabIndex={0}
                role='region'
                aria-label={text('hourlyTitle')}
            >
                <table className='w-full min-w-[44rem] text-left text-sm'>
                    <caption className='sr-only'>{text('hourlyHint')}</caption>
                    <thead>
                        <tr className='border-b'>
                            <th scope='col' className='p-3'>
                                {text('recordingHour')}
                            </th>
                            <th scope='col' className='p-3'>
                                {text('state')}
                            </th>
                            {columns.map((key) => (
                                <th scope='col' className='p-3' key={key}>
                                    {text(`counters.${key}`)}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((point) => (
                            <tr
                                key={point.bucketStart.toISOString()}
                                className='border-b last:border-0'
                            >
                                <th scope='row' className='p-3 font-normal'>
                                    {date(point.bucketStart)}
                                </th>
                                <td className='p-3'>
                                    {text(`states.${point.state}`)}
                                </td>
                                {columns.map((key) => (
                                    <td className='p-3 tabular-nums' key={key}>
                                        {point.counters
                                            ? activityNumber(
                                                  point.counters[key],
                                                  locale
                                              )
                                            : text('notObserved')}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
                <p role='status'>
                    {text('page', { page: currentPage + 1, total: pageCount })}
                </p>
                <div className='flex gap-2'>
                    <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        disabled={currentPage === 0}
                        onClick={() => setPage(currentPage - 1)}
                    >
                        {text('newerHours')}
                    </Button>
                    <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        disabled={currentPage + 1 >= pageCount}
                        onClick={() => setPage(currentPage + 1)}
                    >
                        {text('olderHours')}
                    </Button>
                </div>
            </div>
        </details>
    );
}
