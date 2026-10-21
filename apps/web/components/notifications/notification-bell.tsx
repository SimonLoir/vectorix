'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BellIcon, ExternalLinkIcon, Settings2Icon } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { NotificationList } from './notification-list';
import { useNotifications } from './notification-provider';

/** Shows the active tenant's unread badge and a compact inbox preview. */
export function NotificationBell() {
    const t = useTranslations('notifications');
    const [open, setOpen] = useState(false);
    const { scope, unreadCount, countPending, countError } = useNotifications();

    if (!scope) return null;

    const label = countError
        ? t('bellError')
        : t('bellLabel', { count: unreadCount });

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <Button
                    type='button'
                    variant='outline'
                    size='icon'
                    aria-label={label}
                    title={label}
                    aria-busy={countPending}
                    className='relative'
                >
                    <BellIcon aria-hidden='true' />
                    {unreadCount > 0 ? (
                        <span
                            aria-hidden='true'
                            className='absolute -top-1.5 -right-1.5 flex min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-5 text-white shadow-sm'
                        >
                            {unreadCount > 99 ? '99+' : unreadCount}
                        </span>
                    ) : null}
                </Button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align='end'
                    sideOffset={8}
                    className='z-50 w-[min(26rem,calc(100vw-1rem))] overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg outline-none'
                >
                    <div className='flex items-center justify-between gap-3 border-b px-4 py-3'>
                        <p className='font-semibold'>{t('title')}</p>
                        <div className='flex items-center gap-1'>
                            <Button
                                variant='ghost'
                                size='icon'
                                asChild
                                aria-label={t('preferencesLink')}
                                title={t('preferencesLink')}
                            >
                                <Link
                                    href='/dashboard/notifications/preferences'
                                    onClick={() => setOpen(false)}
                                >
                                    <Settings2Icon aria-hidden='true' />
                                </Link>
                            </Button>
                            <Button variant='ghost' size='sm' asChild>
                                <Link
                                    href='/dashboard/notifications'
                                    onClick={() => setOpen(false)}
                                >
                                    {t('viewAll')}
                                    <ExternalLinkIcon aria-hidden='true' />
                                </Link>
                            </Button>
                        </div>
                    </div>
                    <div className='max-h-[min(70dvh,38rem)] overflow-y-auto'>
                        <NotificationList
                            compact
                            onNavigate={() => setOpen(false)}
                        />
                    </div>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
}
