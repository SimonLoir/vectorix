'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import type { AdminUser } from './user-types';
import {
    UserSuperAdminConfirmation,
    type UserAccessSnapshot,
} from './user-superadmin-confirmation';

/** Explicit audited access control; withdrawing one's own privilege purges the console cache. */
export function UserSuperAdminAccess({
    user,
    superAdminCount,
    fetching,
    onReload,
}: Readonly<{
    user: AdminUser;
    superAdminCount: number;
    fetching: boolean;
    onReload: () => Promise<boolean>;
}>) {
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const router = useRouter();
    const me = useQuery(orpc.superadmin.me.queryOptions({}));
    const [snapshot, setSnapshot] = useState<UserAccessSnapshot | null>(null);
    const [requiresReload, setRequiresReload] = useState(false);
    const mutation = useMutation(
        orpc.superadmin.users.setSuperAdmin.mutationOptions({
            retry: false,
            onError: () => setRequiresReload(true),
            onSuccess: async (result) => {
                setSnapshot(null);
                setRequiresReload(false);
                toast.success(
                    result.isSuperAdmin
                        ? 'Utilisateur nommé superadmin'
                        : 'Accès superadmin retiré'
                );
                if (result.id === me.data?.user.id && !result.isSuperAdmin) {
                    queryClient.removeQueries({
                        queryKey: orpc.superadmin.key(),
                    });
                    router.replace('/sign-in');
                    return;
                }
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.users.key(),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.audit.key(),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.me.key(),
                    }),
                ]);
            },
        })
    );
    const lastSuperAdmin = user.isSuperAdmin && superAdminCount <= 1;

    async function reload() {
        if (await onReload()) {
            mutation.reset();
            setRequiresReload(false);
        }
    }

    return (
        <section className='admin-panel p-6'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
                <h2 className='flex items-center gap-2 font-semibold text-slate-100'>
                    <ShieldCheck className='h-5 w-5 text-cyan-300' />
                    Accès à la console
                </h2>
                <Badge
                    variant='outline'
                    className={
                        user.isSuperAdmin
                            ? 'border-cyan-400/20 text-cyan-200'
                            : 'border-white/10 text-slate-400'
                    }
                >
                    {user.isSuperAdmin ? 'Superadmin' : 'Sans accès console'}
                </Badge>
            </div>
            <p className='mt-4 text-sm leading-6 text-slate-400'>
                Les superadmins gèrent les utilisateurs, les organisations et
                les réglages de la console Vectorix.
            </p>
            {lastSuperAdmin ? (
                <p className='mt-4 rounded-xl border border-amber-400/15 bg-amber-400/[0.05] p-3 text-xs leading-5 text-amber-200'>
                    Cet utilisateur est le dernier superadmin. Nommez une autre
                    personne avant de retirer son accès.
                </p>
            ) : null}
            {requiresReload ? (
                <p role='alert' className='mt-4 text-xs text-amber-200'>
                    Rechargez la fiche avant tout nouveau changement.
                </p>
            ) : null}
            <div className='mt-5 flex flex-wrap gap-2'>
                <Button
                    disabled={
                        lastSuperAdmin ||
                        fetching ||
                        me.isPending ||
                        me.isError ||
                        mutation.isPending ||
                        requiresReload
                    }
                    onClick={() => {
                        mutation.reset();
                        setSnapshot({
                            userId: user.id,
                            name: user.name,
                            email: user.email,
                            enabled: !user.isSuperAdmin,
                            expectedIsSuperAdmin: user.isSuperAdmin,
                            expectedUpdatedAt: user.updatedAt,
                        });
                    }}
                >
                    {user.isSuperAdmin
                        ? 'Retirer l’accès superadmin'
                        : 'Nommer superadmin'}
                </Button>
                <Button
                    variant='outline'
                    disabled={
                        fetching || mutation.isPending || snapshot !== null
                    }
                    onClick={() => void reload()}
                >
                    <RefreshCw
                        className={`h-4 w-4 ${fetching ? 'animate-spin' : ''}`}
                    />
                    Recharger la fiche
                </Button>
            </div>
            <UserSuperAdminConfirmation
                snapshot={snapshot}
                pending={mutation.isPending}
                requiresReload={requiresReload}
                error={mutation.isError ? mutation.error.message : undefined}
                onClose={() => setSnapshot(null)}
                onConfirm={(captured) =>
                    mutation.mutate({
                        userId: captured.userId,
                        enabled: captured.enabled,
                        expectedIsSuperAdmin: captured.expectedIsSuperAdmin,
                        expectedUpdatedAt: captured.expectedUpdatedAt,
                    })
                }
            />
        </section>
    );
}
