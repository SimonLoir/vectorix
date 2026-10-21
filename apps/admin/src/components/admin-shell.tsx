'use client';
import { useTranslations } from 'next-intl';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
    Building2,
    ChevronRight,
    LayoutDashboard,
    LogOut,
    Orbit,
    ScrollText,
    ShieldCheck,
    SlidersHorizontal,
    Users,
} from 'lucide-react';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { cn } from '@repo/ui/utils';
import { useORPC } from '@/hooks/use-orpc';
import { LanguageSwitcher } from './language-switcher';
import { LoadingState } from './loading-state';

const navigation = [
    { href: '/', label: 'shell.dashboard', icon: LayoutDashboard },
    { href: '/organizations', label: 'shell.organizations', icon: Building2 },
    { href: '/users', label: 'shell.users', icon: Users },
    { href: '/features', label: 'shell.features', icon: SlidersHorizontal },
    { href: '/audit', label: 'shell.audit', icon: ScrollText },
] as const;

export function AdminShell({
    children,
}: {
    readonly children: React.ReactNode;
}) {
    const tr = useTranslations('admin');
    const pathname = usePathname();
    const router = useRouter();
    const auth = useAuth();
    const { orpc } = useORPC();
    const meQuery = useQuery(orpc.superadmin.me.queryOptions({}));

    if (meQuery.isPending) {
        return <LoadingState label={tr('shell.loading')} />;
    }

    if (meQuery.isError || !meQuery.data?.user.isSuperAdmin) {
        return (
            <main className='flex min-h-screen items-center justify-center p-6'>
                <div className='max-w-md rounded-2xl border border-white/10 bg-[#101827] p-8 text-center shadow-2xl'>
                    <Orbit className='mx-auto h-10 w-10 text-red-600' />
                    <h1 className='mt-4 text-xl font-semibold'>
                        {tr('shell.denied')}
                    </h1>
                    <p className='mt-2 text-sm text-muted-foreground'>
                        {tr('shell.deniedHint')}
                    </p>
                    <Button
                        className='mt-6'
                        variant='outline'
                        onClick={async () => {
                            await auth.signOut();
                            router.replace('/sign-in');
                        }}
                    >
                        {tr('shell.switchAccount')}
                    </Button>
                </div>
            </main>
        );
    }

    const currentNavigation = navigation.findLast((item) =>
        item.href === '/' ? pathname === '/' : pathname.startsWith(item.href)
    );
    const initials = meQuery.data.user.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase();

    return (
        <div className='min-h-screen lg:grid lg:grid-cols-[268px_1fr]'>
            <aside className='relative z-20 border-b border-white/10 bg-[#080d18] text-slate-100 lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col lg:border-b-0 lg:border-r'>
                <div className='pointer-events-none absolute inset-0 overflow-hidden'>
                    <div className='absolute -left-24 -top-28 h-72 w-72 rounded-full bg-indigo-500/15 blur-3xl' />
                    <div className='absolute -bottom-28 -right-24 h-64 w-64 rounded-full bg-sky-400/10 blur-3xl' />
                </div>
                <div className='relative flex h-[76px] items-center gap-3 border-b border-white/8 px-5'>
                    <span className='flex h-10 w-10 items-center justify-center rounded-[14px] bg-gradient-to-br from-indigo-500 to-blue-600 shadow-lg shadow-indigo-950/40'>
                        <Orbit className='h-5 w-5' />
                    </span>
                    <p className='font-semibold tracking-tight'>Vectorix</p>
                    <Button
                        className='ml-auto border-white/10 bg-white/5 text-slate-200 hover:bg-white/10 lg:hidden'
                        size='icon'
                        variant='outline'
                        title={tr('shell.signOut')}
                        onClick={async () => {
                            await auth.signOut();
                            router.replace('/sign-in');
                        }}
                    >
                        <LogOut className='h-4 w-4' />
                    </Button>
                </div>
                <div className='relative px-5 py-2'>
                    <LanguageSwitcher />
                </div>
                <nav className='relative flex gap-2 overflow-x-auto p-3 lg:flex-col lg:p-4 lg:pt-7'>
                    <p className='mb-2 hidden px-3 text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 lg:block'>
                        {tr('shell.workspace')}
                    </p>
                    {navigation.map((item) => {
                        const active =
                            item.href === '/'
                                ? pathname === '/'
                                : pathname.startsWith(item.href);
                        const Icon = item.icon;
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={cn(
                                    'group flex h-11 shrink-0 items-center gap-3 rounded-xl px-3 text-sm font-medium transition-all',
                                    active
                                        ? 'border border-cyan-400/15 bg-cyan-400/10 text-cyan-100 shadow-lg shadow-black/10'
                                        : 'text-slate-400 hover:bg-white/6 hover:text-white'
                                )}
                            >
                                <span
                                    className={cn(
                                        'grid h-7 w-7 place-items-center rounded-lg transition-colors',
                                        active
                                            ? 'bg-cyan-400/15 text-cyan-300'
                                            : 'bg-white/5 text-slate-500 group-hover:text-white'
                                    )}
                                >
                                    <Icon className='h-4 w-4' />
                                </span>
                                {tr(item.label)}
                                {active ? (
                                    <ChevronRight className='ml-auto hidden h-4 w-4 text-slate-400 lg:block' />
                                ) : null}
                            </Link>
                        );
                    })}
                </nav>
                <div className='relative mt-auto hidden p-4 lg:block'>
                    <div className='rounded-2xl border border-white/8 bg-white/5 p-3'>
                        <div className='flex items-center gap-3'>
                            <span className='grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-indigo-500/20 text-xs font-bold text-indigo-200'>
                                {initials}
                            </span>
                            <div className='min-w-0 flex-1'>
                                <p className='truncate text-sm font-medium text-white'>
                                    {meQuery.data.user.name}
                                </p>
                                <p className='truncate text-[11px] text-slate-500'>
                                    {meQuery.data.user.email}
                                </p>
                            </div>
                            <Button
                                className='h-8 w-8 text-slate-500 hover:bg-white/10 hover:text-white'
                                size='icon'
                                variant='ghost'
                                title={tr('shell.signOut')}
                                onClick={async () => {
                                    await auth.signOut();
                                    router.replace('/sign-in');
                                }}
                            >
                                <LogOut className='h-4 w-4' />
                            </Button>
                        </div>
                    </div>
                </div>
            </aside>
            <div className='min-w-0'>
                <header className='hidden h-[76px] items-center justify-between border-b border-white/8 bg-[#0b111e]/80 px-8 backdrop-blur-xl lg:flex xl:px-10'>
                    <div>
                        <p className='text-xs font-medium text-slate-400'>
                            {tr('shell.administration')}
                        </p>
                        <p className='text-sm font-semibold text-slate-200'>
                            {currentNavigation
                                ? tr(currentNavigation.label)
                                : tr('workspace.organization')}
                        </p>
                    </div>
                    <div className='flex items-center gap-3'>
                        <div className='flex items-center gap-2 rounded-full border border-emerald-400/15 bg-emerald-400/8 px-3 py-1.5 text-xs font-medium text-emerald-300'>
                            <ShieldCheck className='h-3.5 w-3.5' />
                            {tr('shell.access')}
                        </div>
                    </div>
                </header>
                <main className='mx-auto min-w-0 max-w-[1500px] p-5 sm:p-8 lg:p-10 xl:px-12'>
                    {children}
                </main>
            </div>
        </div>
    );
}
