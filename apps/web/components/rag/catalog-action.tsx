'use client';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
    requestErrorKey,
    type RequestErrorKey,
} from '@repo/dashboard-core/lib/request-errors';

/** Invalidate every affected organization query, including permissions, scopes, quotas and audit. */
export function useCatalogAction() {
    const tr = useTranslations('rag');
    const errors = useTranslations('requestErrors');
    const cache = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [errorKey, setErrorKey] = useState<RequestErrorKey | null>(null);
    async function run(action: () => Promise<unknown>, done?: () => void) {
        setBusy(true);
        setErrorKey(null);
        try {
            await action();
            await cache.invalidateQueries();
            toast.success(tr('common.saved'));
            done?.();
        } catch (cause) {
            setErrorKey(requestErrorKey(cause));
        } finally {
            setBusy(false);
        }
    }
    return { busy, error: errorKey ? errors(errorKey) : null, run };
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
