'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckCircle2, Mail, UserRound } from 'lucide-react';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { LoadingState } from './loading-state';
import { UserSuperAdminAccess } from './user-superadmin-access';
import { UserMemberships } from './user-memberships';

/** Selected global account dossier with independent, paginated organization memberships. */
export function UserWorkspace({ userId }: Readonly<{ userId: string }>) {
    const { orpc } = useORPC();
    const [page, setPage] = useState(1);
    const limit = 20;
    const query = useQuery(
        orpc.superadmin.users.get.queryOptions({
            input: { userId, page, limit },
        })
    );

    if (query.isPending)
        return <LoadingState label='Chargement de l’utilisateur…' />;
    if (query.isError)
        return (
            <div className='space-y-3'>
                <p role='alert' className='text-sm text-destructive'>
                    {query.error.message}
                </p>
                <Button
                    variant='outline'
                    disabled={query.isFetching}
                    onClick={() => void query.refetch()}
                >
                    Recharger la fiche
                </Button>
            </div>
        );
    const { user, memberships, totalMemberships, superAdminCount } = query.data;

    return (
        <div className='space-y-6'>
            <Button
                asChild
                variant='ghost'
                className='-ml-3 w-fit text-slate-500 hover:text-slate-200'
            >
                <Link href='/users'>
                    <ArrowLeft className='h-4 w-4' />
                    Tous les utilisateurs
                </Link>
            </Button>
            <section className='admin-panel p-6 sm:p-8'>
                <div className='flex items-start gap-4'>
                    <span className='grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-indigo-400/10 text-indigo-300'>
                        <UserRound className='h-6 w-6' />
                    </span>
                    <div className='min-w-0'>
                        <h1 className='break-words text-2xl font-semibold tracking-tight text-slate-100'>
                            {user.name}
                        </h1>
                        <p className='mt-2 flex items-start gap-2 break-all text-sm text-slate-400'>
                            <Mail className='mt-0.5 h-4 w-4 shrink-0' />
                            {user.email}
                        </p>
                        <div className='mt-4 flex flex-wrap items-center gap-3'>
                            <Badge
                                variant='outline'
                                className={
                                    user.emailVerified
                                        ? 'border-emerald-400/20 text-emerald-300'
                                        : 'border-white/10 text-slate-400'
                                }
                            >
                                {user.emailVerified ? (
                                    <>
                                        <CheckCircle2 className='h-3 w-3' />
                                        E-mail vérifié
                                    </>
                                ) : (
                                    'E-mail non vérifié'
                                )}
                            </Badge>
                            <span className='text-xs text-slate-500'>
                                Inscrit le{' '}
                                {new Date(user.createdAt).toLocaleDateString(
                                    'fr-BE'
                                )}
                            </span>
                        </div>
                    </div>
                </div>
            </section>
            <div className='grid items-start gap-6 xl:grid-cols-[0.9fr_1.1fr]'>
                <UserSuperAdminAccess
                    key={user.id}
                    user={user}
                    superAdminCount={superAdminCount}
                    fetching={query.isFetching}
                    onReload={async () => (await query.refetch()).isSuccess}
                />
                <UserMemberships
                    memberships={memberships}
                    total={totalMemberships}
                    page={page}
                    pageCount={Math.max(1, Math.ceil(totalMemberships / limit))}
                    fetching={query.isFetching}
                    onPageChange={setPage}
                />
            </div>
        </div>
    );
}
