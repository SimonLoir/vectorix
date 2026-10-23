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
    operation: string;
    children: ReactNode;
}>) {
    const tr = useTranslations('rag');
    const { isPending, isError, errorKey, canOperation, refresh } =
        useVectorixPermissions();
    return (
        <DashboardPage className='space-y-6'>
            <header>
                <p className='mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground'>
                    {tr('page.eyebrow')}
                </p>
                <h1 className='text-3xl font-semibold tracking-tight'>
                    {tr(titleKey)}
                </h1>
                <p className='mt-2 max-w-3xl text-muted-foreground'>
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
            ) : canOperation(operation) ? (
                children
            ) : (
                <RequestErrorState errorKey='permission' onRetry={refresh} />
            )}
        </DashboardPage>
    );
}
