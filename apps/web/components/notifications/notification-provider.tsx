'use client';

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useORPC } from '@/hooks/use-orpc';

export type NotificationScope = Readonly<{
    organizationId: string;
    sessionId: string;
    userId: string;
    cacheKey: string;
}>;

type NotificationContextValue = Readonly<{
    scope: NotificationScope | null;
    unreadCount: number;
    countPending: boolean;
    countError: boolean;
    invalidate: () => Promise<void>;
}>;

const EMPTY_CONTEXT: NotificationContextValue = {
    scope: null,
    unreadCount: 0,
    countPending: false,
    countError: false,
    invalidate: () => Promise.resolve(),
};

const NotificationContext = createContext<NotificationContextValue | null>(
    null
);

function belongsToScope(queryKey: readonly unknown[], cacheKey: string) {
    return queryKey.includes(cacheKey);
}

function ScopedNotificationProvider({
    children,
    scope,
}: Readonly<{ children: ReactNode; scope: NotificationScope }>) {
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const countOptions = orpc.admin.notifications.unreadCount.queryOptions({});
    const countQuery = useQuery({
        ...countOptions,
        queryKey: [...countOptions.queryKey, scope.cacheKey],
        staleTime: 0,
        refetchInterval: () =>
            globalThis.document?.visibilityState === 'visible' ? 30_000 : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: 'always',
        refetchOnWindowFocus: 'always',
        retry: false,
    });
    const refetchCount = countQuery.refetch;

    const invalidate = useCallback(async () => {
        await queryClient.invalidateQueries({
            predicate: (query) =>
                belongsToScope(query.queryKey, scope.cacheKey),
        });
    }, [queryClient, scope.cacheKey]);

    useEffect(() => {
        const refreshWhenVisible = () => {
            if (globalThis.document.visibilityState === 'visible') {
                void refetchCount();
            }
        };
        globalThis.document.addEventListener(
            'visibilitychange',
            refreshWhenVisible
        );
        return () => {
            globalThis.document.removeEventListener(
                'visibilitychange',
                refreshWhenVisible
            );
        };
    }, [refetchCount]);

    useEffect(() => {
        const cacheKey = scope.cacheKey;
        return () => {
            void queryClient.cancelQueries({
                predicate: (query) => belongsToScope(query.queryKey, cacheKey),
            });
            queryClient.removeQueries({
                predicate: (query) => belongsToScope(query.queryKey, cacheKey),
            });
        };
    }, [queryClient, scope.cacheKey]);

    return (
        <NotificationContext
            value={{
                scope,
                unreadCount: countQuery.data?.count ?? 0,
                countPending: countQuery.isPending,
                countError: countQuery.isError,
                invalidate,
            }}
        >
            {children}
        </NotificationContext>
    );
}

/** Keeps notification queries isolated to one authenticated dashboard identity. */
export function NotificationProvider({
    children,
}: Readonly<{ children: ReactNode }>) {
    const auth = useAuth();
    const { data: session } = auth.useSession();
    const organizationId = session?.session.activeOrganizationId;
    const sessionId = session?.session.id;
    const userId = session?.user.id;

    if (!organizationId || !sessionId || !userId) {
        return (
            <NotificationContext value={EMPTY_CONTEXT}>
                {children}
            </NotificationContext>
        );
    }

    const cacheKey = `notification-scope:${organizationId}:${sessionId}:${userId}`;
    const scope = { organizationId, sessionId, userId, cacheKey };
    return (
        <ScopedNotificationProvider key={cacheKey} scope={scope}>
            {children}
        </ScopedNotificationProvider>
    );
}

/** Returns the active notification identity and its unread counter. */
export function useNotifications() {
    const context = useContext(NotificationContext);
    if (!context) throw new Error('NotificationProvider is required');
    return context;
}
