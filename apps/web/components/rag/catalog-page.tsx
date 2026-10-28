'use client';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import DashboardPage from '@/components/dashboard-page';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { RequestErrorState } from '@/components/request-error-state';

/** Mount business queries only after current organization permissions are known. */
export function CatalogPage({
    titleKey,
    descriptionKey,
    operation,
    children,
}: Readonly<{
    titleKey: string;
    descriptionKey: string;
    operation: string | readonly string[];
    children: ReactNode;
}>) {
    const tr = useTranslations('rag');
    const { isPending, isError, errorKey, canOperation, refresh } =
        useVectorixPermissions();
    const allowed =
        typeof operation === 'string'
            ? canOperation(operation)
            : operation.some(canOperation);
    return (
        <DashboardPage className='space-y-6'>
            <header className='vectorix-catalog-header'>
                <p className='mb-3 inline-flex rounded-full border border-primary/15 bg-primary/8 px-3 py-1 text-xs font-semibold tracking-wide text-primary dark:text-accent-foreground'>
                    {tr('page.eyebrow')}
                </p>
                <h1 className='text-3xl font-semibold tracking-tight'>
                    {tr(titleKey)}
                </h1>
                <p className='mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base'>
                    {tr(descriptionKey)}
                </p>
            </header>
            {isError ? (
                <RequestErrorState
                    errorKey={errorKey ?? 'generic'}
                    onRetry={refresh}
                />
            ) : isPending ? (
                <p role='status'>{tr('page.permissionLoading')}</p>
            ) : allowed ? (
                children
            ) : (
                <RequestErrorState errorKey='permission' onRetry={refresh} />
            )}
        </DashboardPage>
    );
}
