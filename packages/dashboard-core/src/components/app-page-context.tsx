'use client';
import React, { createContext, useContext, useEffect, useState } from 'react';

export type Breadcrumb = {
    title: string;
    url?: string;
};
export type AppPageContext = {
    breadcrumbs: Breadcrumb[];
    setBreadcrumbs: (breadcrumbs: Breadcrumb[]) => void;
};

export const appPageContext = createContext<AppPageContext | null>(null);

export const AppPageProvider = ({
    children,
}: Readonly<{ children: React.ReactNode }>) => {
    const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
    return (
        <appPageContext.Provider
            value={{
                breadcrumbs,
                setBreadcrumbs,
            }}
        >
            {children}
        </appPageContext.Provider>
    );
};

export const useAppPageContext = () => {
    const ctx = useContext(appPageContext);
    if (!ctx) {
        throw new Error('useAppPageContext must be used as useAppPageContext');
    }
    return ctx;
};

/**
 * Publishes page-specific breadcrumbs to the application shell while mounted.
 * Shells decide how to combine them with route-derived crumbs; the web
 * dashboard appends them after its navigation trail (for example a collection
 * name). The crumbs are cleared on unmount so they never outlive their page.
 */
export const BreadCrumbs = ({
    breadcrumbs,
}: Readonly<{ breadcrumbs: Breadcrumb[] }>) => {
    const { setBreadcrumbs } = useAppPageContext();
    // Callers usually pass inline arrays; compare by content to avoid update loops.
    const key = JSON.stringify(breadcrumbs);

    useEffect(() => {
        setBreadcrumbs(JSON.parse(key) as Breadcrumb[]);
        return () => setBreadcrumbs([]);
    }, [key, setBreadcrumbs]);

    return null;
};
