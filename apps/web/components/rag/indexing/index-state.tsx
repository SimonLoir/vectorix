'use client';
import { useState } from 'react';
import type { z } from 'zod';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { indexFailure } from '@repo/api-contracts/v1/rag/indexing-types';
import { Button } from '@repo/ui/button';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';

/** Render only public domain codes; transport/provider messages are never UI copy. */
export function useIndexAction() {
    const tr = useTranslations('rag.indexing');
    const cache = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [errorCode, setErrorCode] = useState<
        z.infer<typeof indexFailure> | 'UNKNOWN' | 'RATE_LIMITED' | null
    >(null);
    async function run<T>(
        action: () => Promise<T>,
        done?: (value: T) => void,
        invalidate = true
    ) {
        setBusy(true);
        setErrorCode(null);
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
            if (code?.success) setErrorCode(code.data);
            else
                setErrorCode(
                    requestErrorKey(cause) === 'rateLimited'
                        ? 'RATE_LIMITED'
                        : 'UNKNOWN'
                );
        } finally {
            setBusy(false);
        }
    }
    let error: string | null = null;
    if (errorCode === 'UNKNOWN') error = tr('failed');
    else if (errorCode === 'RATE_LIMITED') error = tr('rateLimited');
    else if (errorCode) error = tr(`errors.${errorCode}`);
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
