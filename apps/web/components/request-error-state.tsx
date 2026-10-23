'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import type { RequestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { Button } from '@repo/ui/button';

/** Render a finite error key while keeping reload and personal-account recovery available. */
export function RequestErrorState({
    errorKey,
    onRetry,
}: Readonly<{ errorKey: RequestErrorKey; onRetry: () => unknown }>) {
    const t = useTranslations('requestErrors');
    return (
        <div
            role='alert'
            className='space-y-3 rounded-lg border border-destructive/40 p-4'
        >
            <p>{t(errorKey)}</p>
            <div className='flex flex-wrap gap-2'>
                <Button
                    type='button'
                    variant='outline'
                    onClick={() => void onRetry()}
                >
                    {t('retry')}
                </Button>
                <Button asChild variant='outline'>
                    <Link href='/dashboard/account'>{t('account')}</Link>
                </Button>
            </div>
        </div>
    );
}
