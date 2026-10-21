'use client';

import type { ReactNode } from 'react';
import { ReactQueryClientProvider } from '@repo/dashboard-core/components/query-client-provider';
import { AuthProvider } from '@repo/dashboard-core/contexts/auth';
import { ORPCProvider } from '@/contexts/orpc';
import { IntlProvider } from '@/contexts/intl';

/** Shared authentication, query and locale providers for the dashboard. */
export function ApplicationProviders({
    children,
    apiUrl,
}: Readonly<{ children: ReactNode; apiUrl: string }>) {
    return (
        <ReactQueryClientProvider>
            <AuthProvider baseURL={apiUrl}>
                <ORPCProvider baseURL={apiUrl}>
                    <IntlProvider>{children}</IntlProvider>
                </ORPCProvider>
            </AuthProvider>
        </ReactQueryClientProvider>
    );
}
