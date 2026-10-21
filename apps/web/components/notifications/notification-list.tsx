'use client';

import { useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useInfiniteQuery, useMutation } from '@tanstack/react-query';
import { useLocale, useTranslations } from 'next-intl';
import {
    ArrowRightIcon,
    BellIcon,
    CheckCheckIcon,
    CheckIcon,
    RefreshCwIcon,
} from 'lucide-react';
import type { VectorixApiV1Outputs } from '@repo/api';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { cn } from '@repo/ui/utils';
import { toast } from 'sonner';
import { useORPC } from '@/hooks/use-orpc';
import { notificationActionPath } from './notification-action-path';
import { useNotifications } from './notification-provider';

type NotificationPage = VectorixApiV1Outputs['admin']['notifications']['list'];
type Notification = NotificationPage['notifications'][number];
type NotificationCursor = NonNullable<NotificationPage['nextCursor']>;
type NotificationEventType = Notification['eventType'];

export const NOTIFICATION_SOURCE_FILTERS = ['ALL', 'ACCOUNT_SIGN_IN'] as const;
export type NotificationSourceFilter =
    (typeof NOTIFICATION_SOURCE_FILTERS)[number];
const EVENT_TYPES_BY_SOURCE = {
    ACCOUNT_SIGN_IN: ['ACCOUNT_SIGN_IN'] as NotificationEventType[],
};

function eventTypesFor(source: NotificationSourceFilter) {
    return source === 'ALL' ? undefined : EVENT_TYPES_BY_SOURCE[source];
}

function NotificationRow({
    notification,
    formattedDate,
    pending,
    onOpen,
    onMarkRead,
}: Readonly<{
    notification: Notification;
    formattedDate: string;
    pending: boolean;
    onOpen: (notification: Notification, path: string) => Promise<void>;
    onMarkRead: (notification: Notification) => Promise<unknown>;
}>) {
    const t = useTranslations('notifications');
    const path = notificationActionPath(notification.action);
    const unread = notification.readAt === null;

    return (
        <li
            className={cn(
                'group flex min-w-0 items-start gap-3 border-b px-3 py-3 last:border-b-0',
                unread && 'bg-primary/[0.04]'
            )}
        >
            <span
                aria-hidden='true'
                className={cn(
                    'mt-1.5 size-2 shrink-0 rounded-full',
                    unread ? 'bg-primary' : 'bg-transparent'
                )}
            />
            <div className='min-w-0 flex-1'>
                {path ? (
                    <button
                        type='button'
                        disabled={pending}
                        onClick={() => void onOpen(notification, path)}
                        className='w-full rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60'
                    >
                        <span className='flex items-start justify-between gap-3'>
                            <span className='font-medium leading-snug'>
                                {notification.title}
                            </span>
                            <ArrowRightIcon className='mt-0.5 size-4 shrink-0 text-muted-foreground' />
                        </span>
                        <span className='mt-1 block text-sm leading-relaxed text-muted-foreground'>
                            {notification.body}
                        </span>
                    </button>
                ) : (
                    <div>
                        <p className='font-medium leading-snug'>
                            {notification.title}
                        </p>
                        <p className='mt-1 text-sm leading-relaxed text-muted-foreground'>
                            {notification.body}
                        </p>
                    </div>
                )}
                <div className='mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground'>
                    <time dateTime={notification.occurredAt.toISOString()}>
                        {formattedDate}
                    </time>
                    {path ? null : (
                        <Badge variant='outline' className='font-normal'>
                            {t('actionUnavailable')}
                        </Badge>
                    )}
                </div>
            </div>
            {unread ? (
                <Button
                    type='button'
                    size='icon-sm'
                    variant='ghost'
                    disabled={pending}
                    aria-label={t('markRead')}
                    title={t('markRead')}
                    onClick={() => void onMarkRead(notification)}
                >
                    <CheckIcon aria-hidden='true' />
                </Button>
            ) : null}
        </li>
    );
}

/** Renders a cursor-paginated inbox and applies server-authoritative read state. */
export function NotificationList({
    unreadOnly = false,
    source = 'ALL',
    compact = false,
    onNavigate,
}: Readonly<{
    unreadOnly?: boolean;
    source?: NotificationSourceFilter;
    compact?: boolean;
    onNavigate?: () => void;
}>) {
    const t = useTranslations('notifications');
    const locale = useLocale();
    const router = useRouter();
    const { orpc } = useORPC();
    const { scope, unreadCount, invalidate } = useNotifications();
    const activeScopeKey = useRef<string | null>(scope?.cacheKey ?? null);
    useEffect(() => {
        activeScopeKey.current = scope?.cacheKey ?? null;
        return () => {
            activeScopeKey.current = null;
        };
    }, [scope?.cacheKey]);
    const eventTypes = eventTypesFor(source);
    const options = orpc.admin.notifications.list.infiniteOptions({
        initialPageParam: null as NotificationCursor | null,
        input: (cursor) => ({
            cursor: cursor ?? undefined,
            limit: compact ? 8 : 25,
            unreadOnly,
            eventTypes,
        }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        enabled: Boolean(scope),
    });
    const query = useInfiniteQuery({
        ...options,
        queryKey: [
            ...options.queryKey,
            scope?.cacheKey ?? 'notification-scope:none',
            source,
            unreadOnly,
            compact ? 'compact' : 'full',
        ],
        retry: false,
        refetchInterval: () =>
            globalThis.document?.visibilityState === 'visible' ? 30_000 : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: 'always',
        refetchOnWindowFocus: 'always',
    });
    const notifications = useMemo(
        () => query.data?.pages.flatMap((page) => page.notifications) ?? [],
        [query.data]
    );
    const formatter = useMemo(
        () =>
            new Intl.DateTimeFormat(locale, {
                dateStyle: 'medium',
                timeStyle: 'short',
                timeZone: 'Europe/Brussels',
            }),
        [locale]
    );
    const markRead = useMutation(
        orpc.admin.notifications.markRead.mutationOptions()
    );
    const markAllRead = useMutation(
        orpc.admin.notifications.markAllRead.mutationOptions()
    );
    const watermark = query.data?.pages[0]?.watermark ?? 0;

    const markOne = async (notification: Notification) => {
        if (!scope || notification.readAt) return true;
        const requestScopeKey = scope.cacheKey;
        try {
            await markRead.mutateAsync({
                id: notification.id,
                expectedOrganizationId: scope.organizationId,
            });
            if (activeScopeKey.current !== requestScopeKey) return false;
            void invalidate();
            return true;
        } catch {
            toast.error(t('markReadError'));
            return false;
        }
    };

    const openNotification = async (
        notification: Notification,
        path: string
    ) => {
        if (!(await markOne(notification))) return;
        onNavigate?.();
        router.push(path);
    };

    const markDisplayedRead = async () => {
        if (!scope || watermark === 0) return;
        const requestScopeKey = scope.cacheKey;
        try {
            await markAllRead.mutateAsync({
                expectedOrganizationId: scope.organizationId,
                watermark,
            });
            if (activeScopeKey.current !== requestScopeKey) return;
            await invalidate();
        } catch {
            toast.error(t('markAllReadError'));
        }
    };

    if (!scope) return null;

    if (query.isPending) {
        return (
            <div
                className='flex min-h-32 items-center justify-center text-sm text-muted-foreground'
                aria-live='polite'
            >
                {t('loading')}
            </div>
        );
    }

    if (query.isError) {
        return (
            <div className='space-y-3 p-4 text-center' role='alert'>
                <p className='text-sm text-destructive'>{t('loadError')}</p>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={query.isFetching}
                    onClick={() => void query.refetch()}
                >
                    <RefreshCwIcon aria-hidden='true' />
                    {t('retry')}
                </Button>
            </div>
        );
    }

    return (
        <div className='min-w-0'>
            <div className='flex items-center justify-between gap-3 border-b px-3 py-2'>
                <p className='text-xs text-muted-foreground' aria-live='polite'>
                    {t('displayedCount', { count: notifications.length })}
                </p>
                <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    disabled={
                        markAllRead.isPending ||
                        watermark === 0 ||
                        (unreadCount === 0 &&
                            !notifications.some(
                                (notification) => !notification.readAt
                            ))
                    }
                    onClick={() => void markDisplayedRead()}
                >
                    <CheckCheckIcon aria-hidden='true' />
                    {t('markAllRead')}
                </Button>
            </div>
            {notifications.length === 0 ? (
                <div className='flex min-h-40 flex-col items-center justify-center gap-2 p-6 text-center'>
                    <BellIcon
                        aria-hidden='true'
                        className='size-7 text-muted-foreground'
                    />
                    <p className='text-sm text-muted-foreground'>
                        {t('empty')}
                    </p>
                </div>
            ) : (
                <ol>
                    {notifications.map((notification) => (
                        <NotificationRow
                            key={notification.id}
                            notification={notification}
                            formattedDate={formatter.format(
                                notification.occurredAt
                            )}
                            pending={markRead.isPending}
                            onOpen={openNotification}
                            onMarkRead={markOne}
                        />
                    ))}
                </ol>
            )}
            {!compact && query.hasNextPage ? (
                <div className='flex justify-center border-t p-3'>
                    <Button
                        type='button'
                        variant='outline'
                        disabled={query.isFetchingNextPage}
                        onClick={() => void query.fetchNextPage()}
                    >
                        {query.isFetchingNextPage
                            ? t('loadingMore')
                            : t('loadMore')}
                    </Button>
                </div>
            ) : null}
        </div>
    );
}
