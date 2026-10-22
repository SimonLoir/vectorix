'use client';

import { useTranslations } from 'next-intl';
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
    const t = useTranslations('admin.secondary');
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
                        ? t('access.granted')
                        : t('access.revoked')
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
                    {t('access.title')}
                </h2>
                <Badge
                    variant='outline'
                    className={
                        user.isSuperAdmin
                            ? 'border-cyan-400/20 text-cyan-200'
                            : 'border-white/10 text-slate-400'
                    }
                >
                    {user.isSuperAdmin
                        ? t('common.superadmin')
                        : t('common.noAccess')}
                </Badge>
            </div>
            <p className='mt-4 text-sm leading-6 text-slate-400'>
                {t('access.description')}
            </p>
            {lastSuperAdmin ? (
                <p className='mt-4 rounded-xl border border-amber-400/15 bg-amber-400/[0.05] p-3 text-xs leading-5 text-amber-200'>
                    {t('access.last')}
                </p>
            ) : null}
            {requiresReload ? (
                <p role='alert' className='mt-4 text-xs text-amber-200'>
                    {t('access.reloadRequired')}
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
                        ? t('access.remove')
                        : t('access.appoint')}
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
                    {t('common.reload')}
                </Button>
            </div>
            <UserSuperAdminConfirmation
                snapshot={snapshot}
                pending={mutation.isPending}
                requiresReload={requiresReload}
                error={mutation.isError ? t('common.saveError') : undefined}
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
