'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

function makeQueryClient() {
    return new QueryClient({
        defaultOptions: {
            queries: {
                staleTime: 60 * 1000,
            },
        },
    });
}
let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
    if (globalThis.window === undefined) {
        return makeQueryClient();
    } else {
        browserQueryClient ??= makeQueryClient();
        return browserQueryClient;
    }
}
export function ReactQueryClientProvider({
    children,
}: Readonly<{ children?: React.ReactNode }>) {
    const queryClient = getQueryClient();
    return (
        <QueryClientProvider client={queryClient}>
            {children}
        </QueryClientProvider>
    );
}
