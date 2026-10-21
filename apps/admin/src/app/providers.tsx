'use client';

import type { ReactNode } from 'react';
import { AuthProvider } from '@repo/dashboard-core/contexts/auth';
import { ReactQueryClientProvider } from '@repo/dashboard-core/components/query-client-provider';
import { ThemeProvider } from '@repo/dashboard-core/components/theme-provider';
import { Toaster } from '@repo/ui/sonner';
import { ORPCProvider } from '@/contexts/orpc';

export function Providers({
    children,
    apiUrl,
}: Readonly<{ children: ReactNode; apiUrl: string }>) {
    return (
        <ReactQueryClientProvider>
            <AuthProvider baseURL={apiUrl}>
                <ORPCProvider baseURL={apiUrl}>
                    <ThemeProvider
                        attribute='class'
                        defaultTheme='dark'
                        forcedTheme='dark'
                        enableSystem={false}
                        disableTransitionOnChange
                    >
                        {children}
                        <Toaster />
                    </ThemeProvider>
                </ORPCProvider>
            </AuthProvider>
        </ReactQueryClientProvider>
    );
}
