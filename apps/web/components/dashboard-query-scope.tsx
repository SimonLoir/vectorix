'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import PaddedSpinner from '@repo/dashboard-core/components/padded-spinner';

/** Business caches and drafts are recreated together when the authenticated tenant changes. */
export function DashboardQueryScope({
    children,
}: Readonly<{ children: ReactNode }>) {
    const { data: session, isPending } = useAuth().useSession();
    if (isPending) return <PaddedSpinner />;
    return (
        <ScopedQueries
            key={`${session?.user.id}:${session?.session.id}:${session?.session.activeOrganizationId}`}
        >
            {children}
        </ScopedQueries>
    );
}

function ScopedQueries({ children }: Readonly<{ children: ReactNode }>) {
    const [client] = useState(
        () =>
            new QueryClient({
                defaultOptions: { queries: { staleTime: 60_000 } },
            })
    );
    useEffect(
        () => () => {
            void client.cancelQueries();
        },
        [client]
    );
    return (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
}
