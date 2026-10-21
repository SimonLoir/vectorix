import Link from 'next/link';
import { ArrowUpRight, Building2 } from 'lucide-react';
import { Button } from '@repo/ui/button';
import type { AdminUserMembership } from './user-types';

const roleLabels: Record<string, string> = {
    owner: 'Propriétaire',
    admin: 'Administrateur',
    member: 'Membre',
};

/** Bounded organization membership page; organization roles are managed in their existing dossiers. */
export function UserMemberships({
    memberships,
    total,
    page,
    pageCount,
    fetching,
    onPageChange,
}: Readonly<{
    memberships: AdminUserMembership[];
    total: number;
    page: number;
    pageCount: number;
    fetching: boolean;
    onPageChange: (page: number) => void;
}>) {
    return (
        <section className='admin-panel overflow-hidden'>
            <div className='border-b border-white/8 px-6 py-5'>
                <h2 className='flex items-center gap-2 font-semibold text-slate-100'>
                    <Building2 className='h-5 w-5 text-indigo-300' />
                    Organisations associées
                </h2>
                <p className='mt-1 text-xs text-slate-500'>
                    {total} organisation(s). Ouvrez un dossier pour gérer le
                    rôle de ce membre.
                </p>
            </div>
            <div className='divide-y divide-white/8'>
                {memberships.map((membership) => (
                    <div
                        key={membership.id}
                        className='flex flex-wrap items-center justify-between gap-3 px-6 py-4'
                    >
                        <div className='min-w-0'>
                            <p className='break-words text-sm font-medium text-slate-200'>
                                {membership.organization.name}
                            </p>
                            <p className='mt-1 text-xs text-slate-500'>
                                {membership.role
                                    .split(',')
                                    .map(
                                        (role) =>
                                            roleLabels[role.trim()] ??
                                            role.trim()
                                    )
                                    .join(', ')}{' '}
                                ·{' '}
                                {membership.organization.isActive
                                    ? 'Active'
                                    : 'Inactive'}
                            </p>
                        </div>
                        <Button asChild variant='ghost' size='sm'>
                            <Link
                                href={`/organizations/${encodeURIComponent(membership.organization.id)}`}
                            >
                                Ouvrir <ArrowUpRight className='h-4 w-4' />
                            </Link>
                        </Button>
                    </div>
                ))}
                {memberships.length === 0 ? (
                    <p className='px-6 py-8 text-sm text-slate-400'>
                        Aucune organisation sur cette page.
                    </p>
                ) : null}
            </div>
            <div className='flex flex-wrap items-center justify-end gap-2 border-t border-white/8 px-6 py-4'>
                <Button
                    variant='outline'
                    size='sm'
                    disabled={page <= 1 || fetching}
                    onClick={() => onPageChange(page - 1)}
                >
                    Précédent
                </Button>
                <span className='px-2 text-xs text-slate-400'>
                    {page} / {pageCount}
                </span>
                <Button
                    variant='outline'
                    size='sm'
                    disabled={page >= pageCount || fetching}
                    onClick={() => onPageChange(page + 1)}
                >
                    Suivant
                </Button>
            </div>
        </section>
    );
}
