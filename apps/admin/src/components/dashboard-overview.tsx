'use client';
import { useTranslations, useFormatter } from 'next-intl';

import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
    ArrowUpRight,
    Building2,
    CircleDollarSign,
    Layers3,
    ShieldCheck,
    SlidersHorizontal,
    Sparkles,
    ToggleRight,
    Users,
} from 'lucide-react';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';

export function DashboardOverview() {
    const tr = useTranslations('admin.core');
    const format = useFormatter();
    const cards = [
        {
            key: 'organizationsTotal',
            label: tr('organizations'),
            detail: tr('accountsTotal'),
            icon: Building2,
            accent: 'bg-indigo-400/10 text-indigo-300',
        },
        {
            key: 'activeOrganizations',
            label: tr('active'),
            detail: tr('activeWorkspaces'),
            icon: ToggleRight,
            accent: 'bg-emerald-400/10 text-emerald-300',
        },
        {
            key: 'usersTotal',
            label: tr('users'),
            detail: tr('registeredAccounts'),
            icon: Users,
            accent: 'bg-sky-400/10 text-sky-300',
        },
        {
            key: 'featuresTotal',
            label: tr('features'),
            detail: tr('catalogModules'),
            icon: SlidersHorizontal,
            accent: 'bg-violet-400/10 text-violet-300',
        },
    ] as const;
    const { orpc } = useORPC();
    const query = useQuery(orpc.superadmin.dashboard.queryOptions({}));

    if (query.isPending) return <LoadingState label={tr('dashboardLoading')} />;
    if (query.isError) {
        return <p className='text-sm text-destructive'>{tr('loadFailed')}</p>;
    }

    const activityRate = query.data.organizationsTotal
        ? Math.round(
              (query.data.activeOrganizations / query.data.organizationsTotal) *
                  100
          )
        : 0;

    return (
        <div className='space-y-6'>
            <section className='relative overflow-hidden rounded-[28px] bg-[#0c1428] px-6 py-7 text-white shadow-[0_20px_50px_rgb(15_23_42/0.16)] sm:px-8 sm:py-9'>
                <div className='pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full bg-indigo-500/25 blur-3xl' />
                <div className='pointer-events-none absolute -bottom-36 left-1/3 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl' />
                <div className='relative flex flex-col gap-7 lg:flex-row lg:items-end lg:justify-between'>
                    <div className='max-w-2xl'>
                        <div className='mb-5 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/7 px-3 py-1.5 text-xs text-indigo-100'>
                            <Sparkles className='h-3.5 w-3.5 text-indigo-300' />
                            {tr('globalManagement')}
                        </div>
                        <h2 className='text-2xl font-semibold tracking-[-0.035em] sm:text-3xl'>
                            {tr('heroTitle')}
                        </h2>
                        <p className='mt-3 max-w-xl text-sm leading-6 text-slate-400'>
                            {tr('heroDescription')}
                        </p>
                    </div>
                    <div className='flex flex-wrap gap-3'>
                        <Button
                            asChild
                            variant='outline'
                            className='border-white/15 bg-white/5 text-white hover:bg-white/10 hover:text-white'
                        >
                            <Link href='/features'>
                                {tr('configureModules')}
                            </Link>
                        </Button>
                        <Button
                            asChild
                            className='bg-cyan-400 text-slate-950 hover:bg-cyan-300'
                        >
                            <Link href='/organizations'>
                                {tr('viewOrganizations')}
                                <ArrowUpRight className='h-4 w-4' />
                            </Link>
                        </Button>
                    </div>
                </div>
            </section>

            <section className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
                {cards.map((card) => {
                    const Icon = card.icon;
                    return (
                        <div key={card.key} className='admin-panel p-5'>
                            <div className='flex items-start justify-between'>
                                <div>
                                    <p className='text-sm font-medium text-slate-400'>
                                        {card.label}
                                    </p>
                                    <p className='mt-3 text-3xl font-semibold tracking-[-0.04em] text-slate-100'>
                                        {format.number(query.data[card.key])}
                                    </p>
                                </div>
                                <span
                                    className={`grid h-10 w-10 place-items-center rounded-xl ${card.accent}`}
                                >
                                    <Icon className='h-5 w-5' />
                                </span>
                            </div>
                            <p className='mt-2 text-xs text-slate-400'>
                                {card.detail}
                            </p>
                        </div>
                    );
                })}
            </section>

            <section className='grid gap-6 xl:grid-cols-[1.35fr_0.65fr]'>
                <div className='admin-panel overflow-hidden'>
                    <div className='flex items-center justify-between border-b border-white/8 px-6 py-5'>
                        <div>
                            <p className='font-semibold text-slate-100'>
                                {tr('platformStatus')}
                            </p>
                            <p className='mt-1 text-xs text-slate-400'>
                                {tr('accessServicesSummary')}
                            </p>
                        </div>
                        <Badge
                            variant='outline'
                            className='border-emerald-400/20 bg-emerald-400/10 text-emerald-300'
                        >
                            <span className='h-1.5 w-1.5 rounded-full bg-emerald-500' />
                            {tr('apiAvailable')}
                        </Badge>
                    </div>
                    <div className='grid gap-px bg-white/8 sm:grid-cols-3'>
                        <div className='bg-[#101827] p-6'>
                            <div className='flex items-center gap-2 text-sm font-medium text-slate-300'>
                                <ShieldCheck className='h-4 w-4 text-emerald-500' />
                                {tr('activeOrganizations')}
                            </div>
                            <p className='mt-4 text-2xl font-semibold text-slate-100'>
                                {format.number(activityRate / 100, {
                                    style: 'percent',
                                    maximumFractionDigits: 0,
                                })}
                            </p>
                            <div className='mt-3 h-1.5 overflow-hidden rounded-full bg-white/8'>
                                <div
                                    className='h-full rounded-full bg-emerald-500'
                                    style={{
                                        width: `${activityRate}%`,
                                    }}
                                />
                            </div>
                        </div>
                        <div className='bg-[#101827] p-6'>
                            <div className='flex items-center gap-2 text-sm font-medium text-slate-300'>
                                <Layers3 className='h-4 w-4 text-indigo-500' />
                                {tr('legacyAccess')}
                            </div>
                            <p className='mt-4 text-2xl font-semibold text-slate-100'>
                                {tr('byException')}
                            </p>
                            <p className='mt-3 text-xs text-slate-400'>
                                {tr('explicitFeatures')}
                            </p>
                        </div>
                        <div className='bg-[#101827] p-6'>
                            <div className='flex items-center gap-2 text-sm font-medium text-slate-300'>
                                <CircleDollarSign className='h-4 w-4 text-amber-500' />
                                {tr('plansSubscriptions')}
                            </div>
                            <p className='mt-4 text-2xl font-semibold text-slate-100'>
                                {tr('externalProvider')}
                            </p>
                            <p className='mt-3 text-xs text-slate-400'>
                                {tr('noLocalPlans')}
                            </p>
                        </div>
                    </div>
                </div>

                <div className='admin-panel p-6'>
                    <p className='font-semibold text-slate-100'>
                        {tr('accessResolution')}
                    </p>
                    <p className='mt-1 text-xs text-slate-400'>
                        {tr('accessModes')}
                    </p>
                    <div className='mt-6 space-y-4'>
                        {[
                            tr('manualMode'),
                            tr('externalMode'),
                            tr('noExternalRights'),
                        ].map((label, index) => (
                            <div
                                key={label}
                                className='flex items-center gap-3'
                            >
                                <span className='grid h-7 w-7 place-items-center rounded-full bg-white/7 text-[11px] font-semibold text-slate-400'>
                                    {format.number(index + 1)}
                                </span>
                                <span className='text-sm text-slate-300'>
                                    {label}
                                </span>
                            </div>
                        ))}
                    </div>
                    <div className='mt-6 rounded-xl border border-white/8 bg-white/[0.025] px-4 py-3 text-xs text-slate-500'>
                        {tr('externalConfiguration', {
                            configured: query.data.externalProviderConfigured
                                ? 'yes'
                                : 'no',
                        })}
                    </div>
                </div>
            </section>
        </div>
    );
}
