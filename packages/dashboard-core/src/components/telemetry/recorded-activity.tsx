'use client';
import { ActivityTotals } from './activity-counters';
import { ActivityDimensions } from './activity-dimensions';
import { ActivityHours } from './activity-hours';
import {
    activityNumber,
    type ActivityFormatting,
    type ActivitySummary,
} from './types';

/** Presentation only: fetching, current access and stale-data denial stay in each app. */
export function RecordedActivity({
    data,
    ...formatting
}: Readonly<{ data: ActivitySummary }> & ActivityFormatting) {
    const { text, date, locale } = formatting;
    return (
        <div className='space-y-5'>
            <p className='text-sm'>
                {text('observedAt', { date: date(data.observedAt) })}
            </p>
            <p className='text-sm'>
                {text('windowRange', {
                    from: date(data.windowStart),
                    to: date(data.windowEnd),
                    count: data.hourCount,
                })}
            </p>
            <p className='text-xs text-muted-foreground'>
                {text('recordingHint')}
            </p>
            <div className='space-y-2 rounded-lg border p-4 text-sm'>
                <p>{text('bestEffort')}</p>
                <p>{text('ledgerHint')}</p>
                <p>{text('retention', { date: date(data.retainedFrom) })}</p>
                <p>
                    {data.tracking.trackingSince
                        ? text('trackingSince', {
                              date: date(data.tracking.trackingSince),
                          })
                        : text('notTracked')}
                </p>
                <p>
                    {data.tracking.lastRecordedAt
                        ? text('lastRecorded', {
                              date: date(data.tracking.lastRecordedAt),
                          })
                        : text('notRecorded')}
                </p>
                <p>
                    {text('gapReports', {
                        count: activityNumber(
                            data.tracking.knownGapReports,
                            locale
                        ),
                    })}
                </p>
                {data.tracking.lastKnownGapReportedAt && (
                    <p>
                        {text('lastGap', {
                            date: date(data.tracking.lastKnownGapReportedAt),
                        })}
                    </p>
                )}
                <p className='text-xs text-muted-foreground'>
                    {text('gapHint')}
                </p>
            </div>
            <p role='status' className='text-sm font-medium'>
                {text(`states.${data.state}`)}
            </p>
            {data.totals && (
                <ActivityTotals counters={data.totals} {...formatting} />
            )}
            <ActivityHours
                key={data.hourCount}
                hourly={data.hourly}
                {...formatting}
            />
            <ActivityDimensions dimensions={data.dimensions} {...formatting} />
        </div>
    );
}
