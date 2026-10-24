'use client';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
/** Keep transport/server errors out of translated product copy. */
export function DocumentQueryState({
    query,
}: Readonly<{
    query: { isError: boolean; isPending: boolean; refetch: () => unknown };
}>) {
    const tr = useTranslations('rag');
    if (query.isError)
        return (
            <div
                role='alert'
                className='space-y-3 rounded-lg border border-destructive/40 p-4'
            >
                <p>{tr('documents.loadFailed')}</p>
                <Button variant='outline' onClick={() => void query.refetch()}>
                    {tr('common.retry')}
                </Button>
            </div>
        );
    return query.isPending ? <p role='status'>{tr('common.loading')}</p> : null;
}
