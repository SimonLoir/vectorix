'use client';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { VectorixApiV1Outputs } from '@repo/api';
import { activityNumber } from '@repo/dashboard-core/components/recorded-activity';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';

type Lane =
    VectorixApiV1Outputs['superadmin']['getWorkerObservations']['items'][number];
const dates = [
    'lastHeartbeatObservedAt',
    'lastScanStartObservedAt',
    'lastScanFinishObservedAt',
    'lastFinishedScanStartObservedAt',
] as const;

function WorkerLane({ lane }: Readonly<{ lane: Lane }>) {
    const text = useTranslations('admin.workers');
    const format = useFormatter();
    const locale = useLocale();
    return (
        <article className='space-y-4 rounded-xl border p-5'>
            <h3 className='font-semibold'>{text(`lanes.${lane.lane}`)}</h3>
            <p className='text-sm font-medium'>
                {text(`states.${lane.state}`)}
            </p>
            <dl className='space-y-3 text-sm'>
                {dates.map((key) => (
                    <div key={key}>
                        <dt className='text-muted-foreground'>{text(key)}</dt>
                        <dd>
                            {lane[key]
                                ? format.dateTime(lane[key], {
                                      dateStyle: 'medium',
                                      timeStyle: 'medium',
                                  })
                                : text('unknown')}
                        </dd>
                    </div>
                ))}
                <div>
                    <dt className='text-muted-foreground'>
                        {text('duration')}
                    </dt>
                    <dd>
                        {lane.lastFinishedScanDurationMicros === null
                            ? text('unknown')
                            : text('micros', {
                                  value: activityNumber(
                                      lane.lastFinishedScanDurationMicros,
                                      locale
                                  ),
                              })}
                    </dd>
                </div>
                <div>
                    <dt className='text-muted-foreground'>{text('outcome')}</dt>
                    <dd>
                        {lane.lastScanOutcome
                            ? text(`outcomes.${lane.lastScanOutcome}`)
                            : text('unknown')}
                    </dd>
                </div>
                <div>
                    <dt className='text-muted-foreground'>{text('failure')}</dt>
                    <dd>
                        {lane.lastSafeFailure
                            ? text(`failures.${lane.lastSafeFailure}`)
                            : text('noFailureObservation')}
                    </dd>
                </div>
            </dl>
        </article>
    );
}

/** Shared lane evidence is global-admin-only and never asserts all replicas or dependencies are healthy. */
export function WorkerObservations() {
    const text = useTranslations('admin.workers');
    const format = useFormatter();
    const { orpc } = useORPC();
    const query = useQuery({
        ...orpc.superadmin.getWorkerObservations.queryOptions({ input: {} }),
        retry: false,
        staleTime: 0,
        refetchInterval: (current) => (current.state.error ? false : 15_000),
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-5'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
                <h2 className='text-lg font-semibold'>{text('title')}</h2>
                <Button
                    type='button'
                    variant='outline'
                    disabled={query.isFetching}
                    onClick={() => void query.refetch()}
                >
                    {text('refresh')}
                </Button>
            </div>
            <p className='text-sm text-muted-foreground'>{text('scope')}</p>
            <p className='text-sm text-muted-foreground'>{text('limits')}</p>
            {query.isPending && <LoadingState label={text('loading')} />}
            {query.isError && (
                <div role='alert' className='space-y-3 rounded-lg border p-4'>
                    <p>{text('loadFailed')}</p>
                    <Button
                        type='button'
                        variant='outline'
                        onClick={() => void query.refetch()}
                    >
                        {text('retry')}
                    </Button>
                </div>
            )}
            {data && (
                <>
                    <p className='text-sm'>
                        {text('observedAt', {
                            date: format.dateTime(data.observedAt, {
                                dateStyle: 'medium',
                                timeStyle: 'medium',
                            }),
                            seconds: data.staleAfterSeconds,
                        })}
                    </p>
                    {data.items.length ? (
                        <div className='grid gap-4 xl:grid-cols-3'>
                            {data.items.map((lane) => (
                                <WorkerLane key={lane.lane} lane={lane} />
                            ))}
                        </div>
                    ) : (
                        <p role='status'>{text('empty')}</p>
                    )}
                </>
            )}
        </section>
    );
}
