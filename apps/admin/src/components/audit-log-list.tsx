'use client';

import { useTranslations, useFormatter } from 'next-intl';
import { Fragment, useDeferredValue, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import {
    Building2,
    ChevronDown,
    ChevronRight,
    Fingerprint,
    Search,
    ShieldCheck,
    UserRound,
} from 'lucide-react';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { Card, CardContent } from '@repo/ui/card';
import { Input } from '@repo/ui/input';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@repo/ui/table';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';

const ACTION_KEYS: Record<string, string> = {
    'vectorix.organization.create': 'organizationCreate',
    'vectorix.organization.update': 'organizationUpdate',
    'vectorix.organization.member.create-user': 'memberCreate',
    'vectorix.organization.member.add-existing-user': 'memberAdd',
    'vectorix.organization.member.update-role': 'memberRole',
    'vectorix.organization.member.remove': 'memberRemove',
    'vectorix.organization.feature_override.set': 'overrideSet',
    'vectorix.organization.feature_override.clear': 'overrideClear',
    'vectorix.feature.create': 'featureCreate',
    'vectorix.feature.update': 'featureUpdate',
    'vectorix.user.setSuperAdmin': 'userAccess',
    'vectorix.organization.setLegacyAccess': 'legacyAccess',
    'vectorix.organization.legacyFeatures.set': 'legacyFeatures',
    'vectorix.organization.ragQuota.update': 'ragQuota',
    'vectorix.organization.semanticQuota.update': 'semanticQuota',
};

function actionStyle(action: string) {
    return action.includes('member')
        ? 'border-indigo-400/20 bg-indigo-400/10 text-indigo-300'
        : action.includes('feature')
          ? 'border-violet-400/20 bg-violet-400/10 text-violet-300'
          : 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300';
}

export function AuditLogList() {
    const t = useTranslations('admin.secondary');
    const format = useFormatter();
    const { orpc } = useORPC();
    const actionLabel = (value: string) => {
        const key = ACTION_KEYS[value];
        return key ? t(`audit.actions.${key}`) : value;
    };
    const [search, setSearch] = useState('');
    const [action, setAction] = useState('');
    const [page, setPage] = useState(1);
    const [expandedId, setExpandedId] = useState<string | null>(null);
    const deferredSearch = useDeferredValue(search.trim());
    const limit = 25;
    const query = useQuery(
        orpc.superadmin.audit.list.queryOptions({
            input: {
                page,
                limit,
                search: deferredSearch || undefined,
                action: action || undefined,
            },
        })
    );
    const pageCount = Math.max(1, Math.ceil((query.data?.total ?? 0) / limit));

    return (
        <div className='space-y-5'>
            <div className='admin-panel flex flex-col gap-3 p-3 lg:flex-row lg:items-center'>
                <div className='relative min-w-0 flex-1'>
                    <Search className='absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500' />
                    <Input
                        className='admin-field border-0 bg-black/20 pl-10 focus-visible:ring-1'
                        aria-label={t('audit.search')}
                        placeholder={t('audit.search')}
                        value={search}
                        onChange={(event) => {
                            setSearch(event.target.value);
                            setPage(1);
                        }}
                    />
                </div>
                <select
                    aria-label={t('audit.filter')}
                    className='admin-field min-w-64 px-3 text-sm'
                    value={action}
                    onChange={(event) => {
                        setAction(event.target.value);
                        setPage(1);
                    }}
                >
                    <option value=''>{t('audit.all')}</option>
                    {query.data?.actions.map((value) => (
                        <option key={value} value={value}>
                            {actionLabel(value)}
                        </option>
                    ))}
                </select>
            </div>

            <Card className='admin-panel overflow-hidden rounded-2xl py-0 shadow-none'>
                <CardContent className='px-0'>
                    {query.isPending ? (
                        <LoadingState label={t('audit.loading')} />
                    ) : query.isError ? (
                        <p className='p-6 text-sm text-destructive'>
                            {t('common.loadError')}
                        </p>
                    ) : (
                        <div className='overflow-x-auto'>
                            <Table>
                                <TableHeader>
                                    <TableRow className='border-white/8 bg-white/[0.025] hover:bg-white/[0.025]'>
                                        <TableHead className='h-12 pl-6'>
                                            {t('audit.date')}
                                        </TableHead>
                                        <TableHead>
                                            {t('common.action')}
                                        </TableHead>
                                        <TableHead>
                                            {t('audit.actor')}
                                        </TableHead>
                                        <TableHead>
                                            {t('audit.target')}
                                        </TableHead>
                                        <TableHead>{t('audit.ip')}</TableHead>
                                        <TableHead className='pr-6 text-right'>
                                            {t('audit.details')}
                                        </TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {query.data.logs.map((log) => {
                                        const expanded = expandedId === log.id;
                                        return (
                                            <Fragment key={log.id}>
                                                <TableRow className='border-white/8 hover:bg-cyan-400/[0.025]'>
                                                    <TableCell className='whitespace-nowrap py-4 pl-6 text-xs text-slate-400'>
                                                        {format.dateTime(
                                                            new Date(
                                                                log.createdAt
                                                            ),
                                                            {
                                                                dateStyle:
                                                                    'medium',
                                                                timeStyle:
                                                                    'short',
                                                            }
                                                        )}
                                                    </TableCell>
                                                    <TableCell>
                                                        <Badge
                                                            variant='outline'
                                                            className={actionStyle(
                                                                log.action
                                                            )}
                                                        >
                                                            {actionLabel(
                                                                log.action
                                                            )}
                                                        </Badge>
                                                        <p className='mt-1.5 font-mono text-[10px] text-slate-600'>
                                                            {log.action}
                                                        </p>
                                                    </TableCell>
                                                    <TableCell>
                                                        <div className='flex items-center gap-2.5'>
                                                            <span className='grid h-8 w-8 place-items-center rounded-lg bg-indigo-400/10 text-indigo-300'>
                                                                <UserRound className='h-3.5 w-3.5' />
                                                            </span>
                                                            <div>
                                                                <p className='text-sm font-medium text-slate-200'>
                                                                    {
                                                                        log.user
                                                                            .name
                                                                    }
                                                                </p>
                                                                <p className='text-[11px] text-slate-500'>
                                                                    {
                                                                        log.user
                                                                            .email
                                                                    }
                                                                </p>
                                                            </div>
                                                        </div>
                                                    </TableCell>
                                                    <TableCell>
                                                        {log.organization ? (
                                                            <Link
                                                                href={`/organizations/${log.organization.id}`}
                                                                className='flex items-center gap-2 text-sm text-slate-300 hover:text-cyan-300'
                                                            >
                                                                <Building2 className='h-3.5 w-3.5' />
                                                                {
                                                                    log
                                                                        .organization
                                                                        .name
                                                                }
                                                            </Link>
                                                        ) : log.targetId ? (
                                                            <span className='flex items-center gap-2 font-mono text-xs text-slate-500'>
                                                                <Fingerprint className='h-3.5 w-3.5' />
                                                                {log.targetId}
                                                            </span>
                                                        ) : (
                                                            <span className='text-sm text-slate-600'>
                                                                —
                                                            </span>
                                                        )}
                                                    </TableCell>
                                                    <TableCell className='font-mono text-xs text-slate-500'>
                                                        {log.ipAddress ?? '—'}
                                                    </TableCell>
                                                    <TableCell className='pr-6 text-right'>
                                                        <Button
                                                            type='button'
                                                            size='sm'
                                                            variant='ghost'
                                                            className='rounded-xl text-slate-400 hover:bg-white/7 hover:text-slate-100'
                                                            aria-expanded={
                                                                expanded
                                                            }
                                                            onClick={() =>
                                                                setExpandedId(
                                                                    expanded
                                                                        ? null
                                                                        : log.id
                                                                )
                                                            }
                                                        >
                                                            {expanded ? (
                                                                <ChevronDown className='h-4 w-4' />
                                                            ) : (
                                                                <ChevronRight className='h-4 w-4' />
                                                            )}
                                                            {t('audit.view')}
                                                        </Button>
                                                    </TableCell>
                                                </TableRow>
                                                {expanded ? (
                                                    <TableRow className='border-white/8 bg-black/15 hover:bg-black/15'>
                                                        <TableCell
                                                            colSpan={6}
                                                            className='px-6 py-5'
                                                        >
                                                            <div className='grid gap-4 lg:grid-cols-[220px_1fr]'>
                                                                <div className='space-y-2 text-xs text-slate-500'>
                                                                    <p className='flex items-center gap-2 text-slate-300'>
                                                                        <ShieldCheck className='h-4 w-4 text-emerald-400' />
                                                                        {t(
                                                                            'audit.immutable'
                                                                        )}
                                                                    </p>
                                                                    <p>
                                                                        {t(
                                                                            'audit.id',
                                                                            {
                                                                                id: log.id,
                                                                            }
                                                                        )}
                                                                    </p>
                                                                    <p>
                                                                        {t(
                                                                            'audit.userId',
                                                                            {
                                                                                id: log
                                                                                    .user
                                                                                    .id,
                                                                            }
                                                                        )}
                                                                    </p>
                                                                    <p>
                                                                        {t(
                                                                            'audit.targetId',
                                                                            {
                                                                                id:
                                                                                    log.targetId ??
                                                                                    t(
                                                                                        'audit.none'
                                                                                    ),
                                                                            }
                                                                        )}
                                                                    </p>
                                                                </div>
                                                                <pre className='max-h-80 overflow-auto rounded-xl border border-white/8 bg-[#080d18] p-4 text-xs leading-5 text-slate-300'>
                                                                    {JSON.stringify(
                                                                        log.details ??
                                                                            {},
                                                                        null,
                                                                        2
                                                                    )}
                                                                </pre>
                                                            </div>
                                                        </TableCell>
                                                    </TableRow>
                                                ) : null}
                                            </Fragment>
                                        );
                                    })}
                                    {query.data.logs.length === 0 ? (
                                        <TableRow>
                                            <TableCell
                                                colSpan={6}
                                                className='h-40 text-center'
                                            >
                                                <ShieldCheck className='mx-auto h-7 w-7 text-slate-700' />
                                                <p className='mt-3 text-sm text-slate-400'>
                                                    {t('audit.empty')}
                                                </p>
                                            </TableCell>
                                        </TableRow>
                                    ) : null}
                                </TableBody>
                            </Table>
                        </div>
                    )}
                </CardContent>
            </Card>

            <div className='flex items-center justify-between px-1 text-sm text-slate-400'>
                <span>
                    {t('audit.total', { count: query.data?.total ?? 0 })}
                </span>
                <div className='flex items-center gap-2'>
                    <Button
                        size='sm'
                        variant='outline'
                        disabled={page <= 1}
                        onClick={() => setPage((current) => current - 1)}
                    >
                        {t('common.previous')}
                    </Button>
                    <span className='px-2 text-xs'>
                        {t('common.page', { page, total: pageCount })}
                    </span>
                    <Button
                        size='sm'
                        variant='outline'
                        disabled={page >= pageCount}
                        onClick={() => setPage((current) => current + 1)}
                    >
                        {t('common.next')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
