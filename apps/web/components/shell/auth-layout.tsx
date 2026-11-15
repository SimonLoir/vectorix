'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FileSearch, History, ShieldCheck } from 'lucide-react';
import { cn } from '@repo/ui/utils';
import { LanguageSwitcher } from '@/components/language-switcher';
import { BrandMark } from './brand-mark';

const highlights = [
    { key: 'citations', icon: FileSearch },
    { key: 'isolation', icon: ShieldCheck },
    { key: 'versions', icon: History },
] as const;

/**
 * Split layout for unauthenticated pages: the form column stays usable at
 * phone width, the brand panel only appears from the `lg` breakpoint.
 */
export function AuthLayout({
    children,
    width = 'sm',
    as: Element = 'div',
}: Readonly<{
    children: ReactNode;
    width?: 'sm' | 'md';
    as?: 'div' | 'main';
}>) {
    const t = useTranslations('authLayout');
    return (
        <Element className='grid min-h-svh bg-background lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]'>
            <div className='flex flex-col px-4 py-5 sm:px-8'>
                <div className='flex items-center justify-between gap-4'>
                    <Link
                        href='/sign-in'
                        className='flex items-center gap-2 rounded-md text-[15px] font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring'
                    >
                        <BrandMark className='size-6' />
                        Vectorix
                    </Link>
                    <LanguageSwitcher />
                </div>
                <div className='flex flex-1 items-center justify-center py-10'>
                    <div
                        className={cn(
                            'w-full',
                            width === 'sm' ? 'max-w-sm' : 'max-w-lg'
                        )}
                    >
                        {children}
                    </div>
                </div>
            </div>
            <aside
                aria-label={t('panelLabel')}
                className='relative hidden overflow-hidden border-l bg-muted/60 lg:flex lg:flex-col lg:justify-end lg:p-12 xl:p-16'
            >
                <div
                    aria-hidden='true'
                    className='absolute inset-0 [background-image:radial-gradient(color-mix(in_oklch,var(--foreground)_14%,transparent)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:radial-gradient(ellipse_at_70%_20%,black,transparent_70%)]'
                />
                <div
                    aria-hidden='true'
                    className='absolute -right-24 -top-24 size-[28rem] rounded-full bg-primary/15 blur-3xl'
                />
                <div className='relative max-w-md space-y-8'>
                    <div className='space-y-3'>
                        <h2 className='text-3xl font-semibold leading-tight tracking-tight'>
                            {t('headline')}
                        </h2>
                        <p className='text-pretty text-muted-foreground'>
                            {t('summary')}
                        </p>
                    </div>
                    <ul className='space-y-3'>
                        {highlights.map(({ key, icon: Icon }) => (
                            <li
                                key={key}
                                className='flex items-start gap-3 text-sm'
                            >
                                <span className='mt-0.5 grid size-7 shrink-0 place-items-center rounded-md border bg-card text-primary shadow-xs'>
                                    <Icon
                                        aria-hidden='true'
                                        className='size-4'
                                    />
                                </span>
                                <span>
                                    <span className='font-medium'>
                                        {t(`highlights.${key}.title`)}
                                    </span>
                                    <span className='block text-muted-foreground'>
                                        {t(`highlights.${key}.body`)}
                                    </span>
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            </aside>
        </Element>
    );
}
