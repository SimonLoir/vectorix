'use client';

import * as React from 'react';
import Link from 'next/link';
import { Building2, LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar';
import { Button } from '@repo/ui/button';

export function OrganizationAvatar({
    name,
    logo,
    loading,
}: Readonly<{
    name: string | null;
    logo: string | null;
    loading: boolean;
}>) {
    let fallback: React.ReactNode = (
        <Building2 aria-hidden='true' className='size-4' />
    );
    if (loading) {
        fallback = (
            <LoaderCircle aria-hidden='true' className='size-4 animate-spin' />
        );
    } else if (name) {
        fallback = name
            .split(' ')
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('');
    }

    return (
        <Avatar className='size-8 rounded-lg'>
            {!loading && <AvatarImage src={logo ?? ''} alt='' />}
            <AvatarFallback className='rounded-lg'>{fallback}</AvatarFallback>
        </Avatar>
    );
}

export function OrganizationRecovery({
    loadFailed,
    switching,
}: Readonly<{ loadFailed: boolean; switching: boolean }>) {
    const t = useTranslations('teamSwitcher');
    return (
        <div className='space-y-2 px-2 pb-2 text-sm group-data-[collapsible=icon]:hidden'>
            <p
                role={loadFailed ? 'alert' : 'status'}
                className='text-muted-foreground'
            >
                {t(
                    loadFailed ? 'loadFailedDescription' : 'noActiveDescription'
                )}
            </p>
            <div className='flex flex-wrap gap-2'>
                <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={switching}
                    onClick={() => globalThis.location.reload()}
                >
                    {t('reload')}
                </Button>
                <Button asChild variant='outline' size='sm'>
                    <Link href='/dashboard/account'>{t('openAccount')}</Link>
                </Button>
            </div>
        </div>
    );
}
