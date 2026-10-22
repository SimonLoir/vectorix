'use client';
import { useTranslations } from 'next-intl';

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import { useORPC } from '@/hooks/use-orpc';

/** Explicit superadmin-only exemption; never creates or cancels a remote financial obligation. */
export function OrganizationLegacyAccess({
    organizationId,
    enabled,
}: {
    readonly organizationId: string;
    readonly enabled: boolean;
}) {
    const tr = useTranslations('admin.core');
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const [confirmationOpen, setConfirmationOpen] = useState(false);
    const mutation = useMutation(
        orpc.superadmin.organizations.setLegacyAccess.mutationOptions({
            onSuccess: async () => {
                setConfirmationOpen(false);
                await Promise.all([
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.organizations.key(),
                    }),
                    queryClient.invalidateQueries({
                        queryKey: orpc.superadmin.dashboard.key(),
                    }),
                ]);
                toast.success(tr('accessModeUpdated'));
            },
        })
    );
    return (
        <Card className='admin-panel rounded-2xl shadow-none'>
            <CardHeader className='space-y-3'>
                <CardTitle className='flex items-center gap-2 text-base'>
                    <ShieldCheck className='h-4 w-4 text-indigo-300' />
                    {tr('vectorixAccess')}
                </CardTitle>
                <div>
                    <Badge variant={enabled ? 'default' : 'secondary'}>
                        {enabled
                            ? tr('legacyOrganization')
                            : tr('externalProvider')}
                    </Badge>
                </div>
            </CardHeader>
            <CardContent className='space-y-4 text-sm'>
                <p className='text-slate-400'>
                    {enabled
                        ? tr('legacyAccessHint')
                        : tr('externalAccessHint')}
                </p>
                <p className='text-xs text-slate-400'>
                    {tr('legacyExceptionHint')}
                </p>
                <Button
                    variant='outline'
                    onClick={() => {
                        mutation.reset();
                        setConfirmationOpen(true);
                    }}
                >
                    {enabled ? tr('removeLegacy') : tr('markLegacy')}
                </Button>
                <Dialog
                    open={confirmationOpen}
                    onOpenChange={(open) => {
                        if (!mutation.isPending) setConfirmationOpen(open);
                    }}
                >
                    <DialogContent closeLabel={tr('close')}>
                        <DialogHeader>
                            <DialogTitle>
                                {enabled
                                    ? tr('returnExternalTitle')
                                    : tr('grantLegacyTitle')}
                            </DialogTitle>
                            <DialogDescription>
                                {enabled
                                    ? tr('returnExternalHint')
                                    : tr('grantLegacyHint')}
                            </DialogDescription>
                        </DialogHeader>
                        <p className='text-sm'>
                            {tr('remoteSubscriptionHint')}
                        </p>
                        {mutation.isError && (
                            <p
                                role='alert'
                                className='text-sm text-destructive'
                            >
                                {tr('saveFailed')}
                            </p>
                        )}
                        <DialogFooter>
                            <Button
                                variant='outline'
                                disabled={mutation.isPending}
                                onClick={() => setConfirmationOpen(false)}
                            >
                                {tr('cancel')}
                            </Button>
                            <Button
                                disabled={mutation.isPending}
                                onClick={() =>
                                    mutation.mutate({
                                        organizationId,
                                        enabled: !enabled,
                                    })
                                }
                            >
                                {mutation.isPending
                                    ? tr('saving')
                                    : tr('confirm')}
                            </Button>
                        </DialogFooter>
                    </DialogContent>
                </Dialog>
            </CardContent>
        </Card>
    );
}
