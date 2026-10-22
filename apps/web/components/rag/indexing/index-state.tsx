'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { indexFailure } from '@repo/api-contracts/v1/rag/indexing-types';
import { Button } from '@repo/ui/button';

/** Render only public domain codes; transport/provider messages are never UI copy. */
export function useIndexAction() {
    const tr = useTranslations('rag.indexing');
    const cache = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    async function run<T>(
        action: () => Promise<T>,
        done?: (value: T) => void,
        invalidate = true
    ) {
        setBusy(true);
        setError(null);
        try {
            const value = await action();
            if (invalidate) await cache.invalidateQueries();
            done?.(value);
        } catch (cause) {
            const data =
                cause && typeof cause === 'object' && 'data' in cause
                    ? cause.data
                    : null;
            const code =
                data && typeof data === 'object' && 'errorCode' in data
                    ? indexFailure.safeParse(data.errorCode)
                    : null;
            setError(code?.success ? tr(`errors.${code.data}`) : tr('failed'));
        } finally {
            setBusy(false);
        }
    }
    return { busy, error, run };
}
export function IndexError({ error }: Readonly<{ error: string | null }>) {
    return error ? (
        <p
            role='alert'
            className='rounded-lg border border-destructive/40 p-3 text-sm'
        >
            {error}
        </p>
    ) : null;
}
export function IndexQueryState({
    query,
}: Readonly<{
    query: { isError: boolean; isPending: boolean; refetch: () => unknown };
}>) {
    const tr = useTranslations('rag');
    if (query.isError)
        return (
            <div role='alert' className='space-y-3 rounded-lg border p-4'>
                <p>{tr('indexing.loadFailed')}</p>
                <Button variant='outline' onClick={() => void query.refetch()}>
                    {tr('common.retry')}
                </Button>
            </div>
        );
    if (query.isPending) return <p role='status'>{tr('common.loading')}</p>;
    return null;
}
