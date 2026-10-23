'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';

export const SECURITY_PAGE_SIZE = 10;

/** Native account endpoints return a list; bound the number of rendered rows. */
export function SecurityPagination({
    page,
    pages,
    onPage,
    disabled,
}: Readonly<{
    page: number;
    pages: number;
    onPage: (page: number) => void;
    disabled: boolean;
}>) {
    const t = useTranslations('accountSecurity.pagination');
    if (pages <= 1) return null;
    return (
        <nav
            className='flex flex-wrap items-center justify-between gap-3'
            aria-label={t('label')}
        >
            <p className='text-muted-foreground text-sm'>
                {t('page', { page: page + 1, pages })}
            </p>
            <div className='flex gap-2'>
                <Button
                    type='button'
                    variant='outline'
                    disabled={disabled || page === 0}
                    onClick={() => {
                        onPage(page - 1);
                    }}
                >
                    {t('previous')}
                </Button>
                <Button
                    type='button'
                    variant='outline'
                    disabled={disabled || page + 1 >= pages}
                    onClick={() => {
                        onPage(page + 1);
                    }}
                >
                    {t('next')}
                </Button>
            </div>
        </nav>
    );
}
