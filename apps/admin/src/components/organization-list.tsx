'use client';

import Link from 'next/link';
import { useDeferredValue, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, Building2, Search, Users } from 'lucide-react';
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
import { StatusBadge } from './status-badge';

type StatusFilter = 'all' | 'active' | 'inactive';

export function OrganizationList() {
    const { orpc } = useORPC();
    const [search, setSearch] = useState('');
    const [status, setStatus] = useState<StatusFilter>('all');
    const [page, setPage] = useState(1);
    const deferredSearch = useDeferredValue(search.trim());
    const limit = 25;
    const query = useQuery(
        orpc.superadmin.organizations.list.queryOptions({
            input: {
                page,
                limit,
                search: deferredSearch || undefined,
                status: status === 'all' ? undefined : status,
            },
        })
    );
    const pageCount = Math.max(1, Math.ceil((query.data?.total ?? 0) / limit));

    return (
        <div className='space-y-5'>
            <div className='admin-panel flex flex-col gap-4 p-3 sm:flex-row sm:items-center sm:justify-between'>
                <div className='flex rounded-xl bg-black/20 p-1'>
                    {(['all', 'active', 'inactive'] as const).map((value) => (
                        <button
                            key={value}
                            type='button'
                            className={`rounded-lg px-3.5 py-2 text-xs font-medium transition-all ${
                                status === value
                                    ? 'bg-white/10 text-cyan-200 shadow-sm'
                                    : 'text-slate-500 hover:text-slate-200'
                            }`}
                            onClick={() => {
                                setStatus(value);
                                setPage(1);
                            }}
                        >
                            {value === 'all'
                                ? 'Toutes'
                                : value === 'active'
                                  ? 'Actives'
                                  : 'Inactives'}
                        </button>
                    ))}
                </div>
                <div className='relative w-full sm:w-96'>
                    <Search className='absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400' />
                    <Input
                        className='admin-field border-0 bg-black/20 pl-10 focus-visible:ring-1'
                        placeholder='Rechercher une organisation…'
                        value={search}
                        onChange={(event) => {
                            setSearch(event.target.value);
                            setPage(1);
                        }}
                    />
                </div>
            </div>

            <Card className='admin-panel overflow-hidden rounded-2xl py-0 shadow-none'>
                <CardContent className='px-0'>
                    {query.isPending ? (
                        <LoadingState />
                    ) : query.isError ? (
                        <p className='p-6 text-sm text-destructive'>
                            {query.error.message}
                        </p>
                    ) : (
                        <Table>
                            <TableHeader>
                                <TableRow className='border-white/8 bg-white/[0.025] hover:bg-white/[0.025]'>
                                    <TableHead className='h-12 pl-6 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                                        Organisation
                                    </TableHead>
                                    <TableHead>Statut</TableHead>
                                    <TableHead>Accès Vectorix</TableHead>
                                    <TableHead>Utilisation</TableHead>
                                    <TableHead className='hidden xl:table-cell'>
                                        Création
                                    </TableHead>
                                    <TableHead className='pr-6 text-right'>
                                        Actions
                                    </TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {query.data.organizations.map(
                                    (organization) => (
                                        <TableRow
                                            key={organization.id}
                                            className='group border-white/8 transition-colors hover:bg-cyan-400/[0.035]'
                                        >
                                            <TableCell className='py-4 pl-6'>
                                                <div className='flex min-w-56 items-center gap-3'>
                                                    <span className='grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-indigo-400/10 bg-indigo-400/8 text-indigo-300 transition-colors group-hover:bg-indigo-400/15'>
                                                        <Building2 className='h-4 w-4' />
                                                    </span>
                                                    <div>
                                                        <p className='font-semibold text-slate-100'>
                                                            {organization.name}
                                                        </p>
                                                        <p className='mt-0.5 text-xs text-slate-400'>
                                                            /{organization.slug}
                                                        </p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <StatusBadge
                                                    active={
                                                        organization.isActive
                                                    }
                                                />
                                            </TableCell>
                                            <TableCell>
                                                <span className='rounded-lg bg-white/7 px-2.5 py-1 text-xs font-medium text-slate-300'>
                                                    {organization.vectorixLegacyAccess
                                                        ? 'Legacy'
                                                        : 'Fournisseur externe'}
                                                </span>
                                            </TableCell>
                                            <TableCell className='text-xs text-slate-500'>
                                                <div className='flex items-center gap-3'>
                                                    <span className='flex items-center gap-1'>
                                                        <Users className='h-3.5 w-3.5 text-slate-400' />
                                                        {
                                                            organization._count
                                                                .members
                                                        }
                                                    </span>
                                                    <span>
                                                        {
                                                            organization._count
                                                                .vectorixFeatureOverrides
                                                        }{' '}
                                                        licences
                                                    </span>
                                                </div>
                                            </TableCell>
                                            <TableCell className='hidden whitespace-nowrap text-xs text-muted-foreground xl:table-cell'>
                                                {new Date(
                                                    organization.createdAt
                                                ).toLocaleDateString('fr-BE')}
                                            </TableCell>
                                            <TableCell className='pr-6 text-right'>
                                                <Button
                                                    asChild
                                                    size='sm'
                                                    variant='ghost'
                                                    className='rounded-xl text-slate-500 hover:bg-white/7 hover:text-cyan-300 hover:shadow-sm'
                                                >
                                                    <Link
                                                        href={`/organizations/${organization.id}`}
                                                    >
                                                        Ouvrir
                                                        <ArrowUpRight className='h-4 w-4' />
                                                    </Link>
                                                </Button>
                                            </TableCell>
                                        </TableRow>
                                    )
                                )}
                                {query.data.organizations.length === 0 ? (
                                    <TableRow>
                                        <TableCell
                                            colSpan={6}
                                            className='h-32 text-center'
                                        >
                                            Aucune organisation trouvée.
                                        </TableCell>
                                    </TableRow>
                                ) : null}
                            </TableBody>
                        </Table>
                    )}
                </CardContent>
            </Card>

            <div className='flex items-center justify-between px-1 text-sm text-slate-400'>
                <span>{query.data?.total ?? 0} organisation(s)</span>
                <div className='flex items-center gap-2'>
                    <Button
                        size='sm'
                        variant='outline'
                        disabled={page <= 1}
                        onClick={() => setPage((current) => current - 1)}
                    >
                        Précédent
                    </Button>
                    <span className='px-2 text-xs'>
                        {page} / {pageCount}
                    </span>
                    <Button
                        size='sm'
                        variant='outline'
                        disabled={page >= pageCount}
                        onClick={() => setPage((current) => current + 1)}
                    >
                        Suivant
                    </Button>
                </div>
            </div>
        </div>
    );
}
