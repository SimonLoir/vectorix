'use client';
import { createContext, ReactNode, useMemo } from 'react';
import type { VectorixApiV1Client } from '@repo/api';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { RPCLink } from '@orpc/client/fetch';
import { createORPCClient } from '@orpc/client';

export type ORPCClient = VectorixApiV1Client;

export const ORPCContext = createContext<{
    client: VectorixApiV1Client;
    orpc: ReturnType<typeof createTanstackQueryUtils<VectorixApiV1Client>>;
    /** Browser-facing API origin, also used to display public webhook URLs. */
    baseURL: string;
} | null>(null);

export const ORPCProvider = ({
    children,
    baseURL,
}: Readonly<{ children: ReactNode; baseURL: string }>) => {
    const clients = useMemo(() => {
        const link = new RPCLink({
            url: `${baseURL}/rpc/v1`,
            headers: async () => {
                if (globalThis.window !== undefined) {
                    return {};
                }

                const { headers } = await import('next/headers');
                return await headers();
            },
            fetch: (request, init) => {
                return fetch(request, {
                    ...init,
                    credentials: 'include',
                });
            },
        });
        const client: VectorixApiV1Client = createORPCClient(link);
        const orpc = createTanstackQueryUtils(client);

        return { client, orpc, baseURL };
    }, [baseURL]);
    return <ORPCContext value={clients}>{children}</ORPCContext>;
};
