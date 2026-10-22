'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import {
    ActivityControls,
    RecordedActivity,
    type ActivityWindow,
} from '@repo/dashboard-core/components/recorded-activity';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';

/** Current-session permission and tenant identity govern both the query and cached rendering. */
export function RecordedActivitySection() {
    const text = useTranslations('rag.telemetry');
    const locale = useLocale();
    const format = useFormatter();
    const auth = useAuth();
    const session = auth.useSession();
    const { orpc } = useORPC();
    const permissions = useVectorixPermissions();
    const [window, setWindow] = useState<ActivityWindow>('24H');
    const organizationId = session.data?.session.activeOrganizationId;
    const allowed = permissions.canOperation('admin.rag.telemetry.summary');
    const options = orpc.admin.rag.telemetry.summary.queryOptions({
        input: { window },
    });
    const enabled =
        allowed &&
        Boolean(organizationId) &&
        !session.isPending &&
        !session.isRefetching;
    const query = useQuery({
        ...options,
        queryKey: [
            ...options.queryKey,
            organizationId,
            session.data?.user.id,
            session.data?.session.id,
        ],
        enabled,
        retry: false,
        staleTime: 0,
        placeholderData: undefined,
        refetchInterval: (current) => (current.state.error ? false : 15_000),
    });
    const data = enabled && !query.isError ? query.data : undefined;
    const denied = !permissions.isPending && !permissions.isError && !allowed;
    return (
        <section className='space-y-5 rounded-xl border p-5 sm:p-6'>
            <h2 className='text-lg font-semibold'>{text('title')}</h2>
            <p className='text-sm text-muted-foreground'>{text('scope')}</p>
            {enabled && (
                <ActivityControls
                    window={window}
                    onWindow={setWindow}
                    text={text}
                    refreshing={query.isFetching}
                    refresh={() => void query.refetch()}
                />
            )}
            {denied && <p role='alert'>{text('denied')}</p>}
            {!denied &&
                !permissions.isError &&
                (query.isPending ||
                    session.isPending ||
                    session.isRefetching) && (
                    <p role='status'>{text('loading')}</p>
                )}
            {(permissions.isError || query.isError) && (
                <div role='alert' className='space-y-3 rounded-lg border p-4'>
                    <p>{text('loadFailed')}</p>
                    <Button
                        type='button'
                        variant='outline'
                        onClick={() => {
                            if (permissions.isError) void permissions.refresh();
                            else if (enabled) void query.refetch();
                        }}
                    >
                        {text('retry')}
                    </Button>
                </div>
            )}
            {data && (
                <RecordedActivity
                    key={window}
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
            {permissions.canOperation('admin.rag.operations.overview') && (
                <Button asChild variant='outline'>
                    <Link href='/dashboard/settings/operations'>
                        {text('operationsLink')}
                    </Link>
                </Button>
            )}
        </section>
    );
}
