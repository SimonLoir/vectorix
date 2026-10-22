'use client';
import { useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import {
    ActivityControls,
    RecordedActivity,
    type ActivityWindow,
} from '@repo/dashboard-core/components/recorded-activity';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';

/** Admin reads the same content-free technical aggregates with an explicit organization input. */
export function OrganizationTelemetry({
    organizationId,
}: Readonly<{ organizationId: string }>) {
    const text = useTranslations('admin.telemetry');
    const locale = useLocale();
    const format = useFormatter();
    const { orpc } = useORPC();
    const [window, setWindow] = useState<ActivityWindow>('24H');
    const query = useQuery({
        ...orpc.superadmin.organizations.getTelemetry.queryOptions({
            input: { organizationId, window },
        }),
        retry: false,
        staleTime: 0,
        placeholderData: undefined,
        refetchInterval: (current) => (current.state.error ? false : 15_000),
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-5'>
            <h2 className='text-lg font-semibold'>{text('title')}</h2>
            <p className='text-sm text-muted-foreground'>{text('scope')}</p>
            <ActivityControls
                window={window}
                onWindow={setWindow}
                text={text}
                refreshing={query.isFetching}
                refresh={() => void query.refetch()}
            />
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
                <RecordedActivity
                    key={`${organizationId}-${window}`}
                    data={data}
                    locale={locale}
                    text={text}
                    date={(value) =>
                        format.dateTime(value, {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                        })
                    }
                />
            )}
        </section>
    );
}
