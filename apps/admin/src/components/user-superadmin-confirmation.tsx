'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';

export type UserAccessSnapshot = Readonly<{
    userId: string;
    name: string;
    email: string;
    enabled: boolean;
    expectedIsSuperAdmin: boolean;
    expectedUpdatedAt: Date;
}>;

/** Confirms the captured identity and global privilege change, retaining failures for explicit reload. */
export function UserSuperAdminConfirmation({
    snapshot,
    pending,
    requiresReload,
    error,
    onClose,
    onConfirm,
}: Readonly<{
    snapshot: UserAccessSnapshot | null;
    pending: boolean;
    requiresReload: boolean;
    error?: string;
    onClose: () => void;
    onConfirm: (snapshot: UserAccessSnapshot) => void;
}>) {
    const t = useTranslations('admin.secondary');
    return (
        <Dialog
            open={snapshot !== null}
            onOpenChange={(open) => {
                if (!open && !pending) onClose();
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>
                        {snapshot?.enabled
                            ? t('access.confirmAppoint')
                            : t('access.confirmRemove')}
                    </DialogTitle>
                    <DialogDescription>
                        {t(
                            snapshot?.enabled
                                ? 'access.appointDescription'
                                : 'access.removeDescription',
                            {
                                name: snapshot?.name ?? '',
                                email: snapshot?.email ?? '',
                            }
                        )}
                    </DialogDescription>
                </DialogHeader>
                <p className='text-sm text-muted-foreground'>
                    {t('access.audit')}
                </p>
                {error ? (
                    <p role='alert' className='text-sm text-destructive'>
                        {error} {t('access.errorRecovery')}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button
                        variant='outline'
                        disabled={pending}
                        onClick={onClose}
                    >
                        {t('common.cancel')}
                    </Button>
                    <Button
                        disabled={!snapshot || pending || requiresReload}
                        onClick={() => {
                            if (snapshot) onConfirm(snapshot);
                        }}
                    >
                        {pending
                            ? t('access.saving')
                            : snapshot?.enabled
                              ? t('access.appoint')
                              : t('access.removeShort')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
