'use client';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/** Invalidate every affected organization query, including permissions, scopes, quotas and audit. */
export function useCatalogAction() {
    const cache = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function run(action: () => Promise<unknown>, done?: () => void) {
        setBusy(true);
        setError(null);
        try {
            await action();
            await cache.invalidateQueries();
            toast.success('Modification enregistrée');
            done?.();
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : 'La modification a échoué.'
            );
        } finally {
            setBusy(false);
        }
    }
    return { busy, error, run };
}
export function ActionError({ error }: Readonly<{ error: string | null }>) {
    return error ? (
        <p
            role='alert'
            className='rounded-md border border-destructive/40 p-3 text-sm'
        >
            {error}
        </p>
    ) : null;
}
