'use client';

import { createContext, useMemo, type ReactNode } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import type { VectorixApiV1Client } from '@repo/api';

// This app only uses superadmin operations. Keeping the client projection
// narrow avoids expanding the whole dashboard contract in every query hook.
export type ORPCClient = Pick<VectorixApiV1Client, 'superadmin'>;

export const ORPCContext = createContext<{
    client: ORPCClient;
    orpc: ReturnType<typeof createTanstackQueryUtils<ORPCClient>>;
} | null>(null);

export function ORPCProvider({
    children,
    baseURL,
}: Readonly<{ children: ReactNode; baseURL: string }>) {
    const value = useMemo(() => {
        const link = new RPCLink({
            url: `${baseURL}/rpc/v1`,
            fetch: (request, init) =>
                fetch(request, { ...init, credentials: 'include' }),
        });
        const client: ORPCClient = createORPCClient(link);
        return {
            client,
            orpc: createTanstackQueryUtils(client),
        };
    }, [baseURL]);

    return (
        <ORPCContext.Provider value={value}>{children}</ORPCContext.Provider>
    );
}
