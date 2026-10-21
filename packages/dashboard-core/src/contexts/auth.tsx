'use client';

import { createAuthClient } from 'better-auth/react';
import { createContext, ReactNode, useMemo } from 'react';
import { authClientPlugins } from '../lib/auth-client';

const getAuthClient = (baseURL: string) => {
    return createAuthClient({
        baseURL,
        plugins: authClientPlugins,
    });
};

export type AuthClient = ReturnType<typeof getAuthClient>;

export const AuthContext = createContext<AuthClient | null>(null);

export const AuthProvider = ({
    children,
    baseURL,
}: Readonly<{ children: ReactNode; baseURL: string }>) => {
    const authClient = useMemo(() => {
        return getAuthClient(baseURL);
    }, [baseURL]);

    return (
        <AuthContext.Provider value={authClient}>
            {children}
        </AuthContext.Provider>
    );
};
