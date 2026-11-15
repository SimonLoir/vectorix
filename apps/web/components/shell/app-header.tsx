'use client';

import { Fragment, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Search } from 'lucide-react';
import { useAppPageContext } from '@repo/dashboard-core/components/app-page-context';
import {
    Breadcrumb,
    BreadcrumbItem,
    BreadcrumbLink,
    BreadcrumbList,
    BreadcrumbPage,
    BreadcrumbSeparator,
} from '@repo/ui/breadcrumb';
import { Button } from '@repo/ui/button';
import { Separator } from '@repo/ui/separator';
import { SidebarTrigger } from '@repo/ui/sidebar';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { ThemeSwitcher } from '@/components/theme-switcher';
import { useCommandPalette } from './command-palette';
import { matchNavigationItem } from './navigation';

type Crumb = { readonly title: string; readonly url?: string };

const subscribeToNothing = () => () => {};

/** Platform-specific shortcut label; the server snapshot keeps hydration stable. */
function useShortcutLabel() {
    return useSyncExternalStore(
        subscribeToNothing,
        () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘K' : 'Ctrl K'),
        () => 'Ctrl K'
    );
}

/**
 * Builds the trail `Group › Section › page crumbs`. Route crumbs come from the
 * shared navigation map; pages may append detail crumbs through `BreadCrumbs`.
 */
function useTrail(): Crumb[] {
    const pathname = usePathname();
    const nav = useTranslations('dashboard.navigation');
    const { breadcrumbs } = useAppPageContext();
    const item = matchNavigationItem(pathname);
    const trail: Crumb[] = [];
    if (item && item.group !== 'workspace') {
        trail.push({ title: nav(`sections.${item.group}`) });
    }
    if (item) {
        trail.push({
            title: nav(item.label),
            url:
                breadcrumbs.length > 0 || pathname !== item.href
                    ? item.href
                    : undefined,
        });
    }
    return [...trail, ...breadcrumbs];
}

/** Sticky dashboard top bar: sidebar toggle, location trail and global actions. */
export function AppHeader() {
    const t = useTranslations('dashboard.commandPalette');
    const trail = useTrail();
    const { open } = useCommandPalette();
    const shortcut = useShortcutLabel();

    return (
        <header className='sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/70 sm:px-4'>
            <SidebarTrigger className='-ml-1' />
            <Separator
                orientation='vertical'
                className='mx-1 data-[orientation=vertical]:h-4'
            />
            <Breadcrumb className='min-w-0 flex-1'>
                <BreadcrumbList className='flex-nowrap'>
                    {trail.map((crumb, index) => {
                        const last = index === trail.length - 1;
                        return (
                            <Fragment key={`${index}:${crumb.title}`}>
                                <BreadcrumbItem
                                    className={
                                        last
                                            ? 'min-w-0'
                                            : 'hidden shrink-0 md:inline-flex'
                                    }
                                >
                                    {last || !crumb.url ? (
                                        <BreadcrumbPage
                                            className={
                                                last
                                                    ? 'truncate font-medium'
                                                    : 'text-muted-foreground'
                                            }
                                        >
                                            {crumb.title}
                                        </BreadcrumbPage>
                                    ) : (
                                        <BreadcrumbLink asChild>
                                            <Link href={crumb.url}>
                                                {crumb.title}
                                            </Link>
                                        </BreadcrumbLink>
                                    )}
                                </BreadcrumbItem>
                                {last ? null : (
                                    <BreadcrumbSeparator className='hidden md:block' />
                                )}
                            </Fragment>
                        );
                    })}
                </BreadcrumbList>
            </Breadcrumb>
            <Button
                type='button'
                variant='outline'
                size='sm'
                onClick={open}
                aria-keyshortcuts='Meta+K Control+K'
                className='h-8 gap-2 text-muted-foreground sm:w-56 sm:justify-start lg:w-64'
            >
                <Search aria-hidden='true' className='size-4' />
                <span className='sr-only sm:not-sr-only sm:flex-1 sm:text-left sm:font-normal'>
                    {t('trigger')}
                </span>
                <kbd className='pointer-events-none hidden h-5 items-center rounded border bg-muted px-1.5 text-[10px] font-medium text-muted-foreground sm:inline-flex'>
                    {shortcut}
                </kbd>
            </Button>
            <ThemeSwitcher />
            <NotificationBell />
        </header>
    );
}
