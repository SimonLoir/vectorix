'use client';
import type { ReactNode } from 'react';
import DashboardPage from '@/components/dashboard-page';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { Button } from '@repo/ui/button';

/** Mount business queries only after current organization permissions are known. */
export function CatalogPage({
    title,
    description,
    operation,
    children,
}: Readonly<{
    title: string;
    description: string;
    operation: string;
    children: ReactNode;
}>) {
    const { isPending, isError, canOperation, refresh } =
        useVectorixPermissions();
    return (
        <DashboardPage className='space-y-6'>
            <header>
                <p className='mb-2 text-xs font-medium uppercase tracking-widest text-muted-foreground'>
                    Vectorix · Catalogue
                </p>
                <h1 className='text-3xl font-semibold tracking-tight'>
                    {title}
                </h1>
                <p className='mt-2 max-w-3xl text-muted-foreground'>
                    {description}
                </p>
            </header>
            {isError ? (
                <div role='alert'>
                    Impossible de vérifier vos permissions.{' '}
                    <Button variant='outline' onClick={() => void refresh()}>
                        Réessayer
                    </Button>
                </div>
            ) : isPending ? (
                <p role='status'>Chargement des permissions…</p>
            ) : canOperation(operation) ? (
                children
            ) : (
                <p role='alert'>
                    Vous n’avez pas accès à cette page dans cette organisation.
                </p>
            )}
        </DashboardPage>
    );
}
