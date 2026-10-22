'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import type { VectorixApiV1Outputs } from '@repo/api';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';

type Counts =
    VectorixApiV1Outputs['superadmin']['organizations']['getOperations']['counts'];
const states = [
    'uploading',
    'due',
    'scheduled',
    'leased',
    'expired',
    'failed',
] as const;

function OrganizationWorkCounts({ counts }: Readonly<{ counts: Counts }>) {
    const tr = useTranslations('admin.operations');
    const format = useFormatter();
    return (
        <div className='grid gap-4 xl:grid-cols-3'>
            {counts.map((count) => (
                <section
                    key={count.category}
                    className='space-y-4 rounded-xl border p-5'
                >
                    <h3 className='font-semibold'>
                        {tr(`categories.${count.category}`)}
                    </h3>
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

/** Platform visibility is aggregate-only and does not introduce a content or recovery route. */
export function OrganizationOperations({
    organizationId,
}: Readonly<{ organizationId: string }>) {
    const tr = useTranslations('admin.operations');
    const format = useFormatter();
    const { orpc } = useORPC();
    const query = useQuery({
        ...orpc.superadmin.organizations.getOperations.queryOptions({
            input: { organizationId },
        }),
        retry: false,
        staleTime: 0,
        refetchInterval: (current) => (current.state.error ? false : 15_000),
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-5'>
            <h2 className='text-lg font-semibold'>{tr('title')}</h2>
            <p className='text-sm text-muted-foreground'>{tr('scope')}</p>
            <p className='text-sm text-muted-foreground'>{tr('timingHint')}</p>
            <p className='text-sm text-muted-foreground'>{tr('unmeasured')}</p>
            {query.isPending && <LoadingState label={tr('loading')} />}
            {query.isError && (
                <div role='alert' className='space-y-3 rounded-lg border p-4'>
                    <p>{tr('loadFailed')}</p>
                    <Button
                        variant='outline'
                        onClick={() => void query.refetch()}
                    >
                        {tr('retry')}
                    </Button>
                </div>
            )}
            {data && (
                <>
                    <div className='flex flex-wrap items-center justify-between gap-3 text-sm'>
                        <p>
                            {tr('observedAt', {
                                date: format.dateTime(data.observedAt, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                }),
                            })}
                        </p>
                        <Button
                            variant='outline'
                            disabled={query.isFetching}
                            onClick={() => void query.refetch()}
                        >
                            {tr('refresh')}
                        </Button>
                    </div>
                    <OrganizationWorkCounts counts={data.counts} />
                </>
            )}
        </section>
    );
}
