'use client';

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
                            ? 'Nommer superadmin ?'
                            : 'Retirer l’accès superadmin ?'}
                    </DialogTitle>
                    <DialogDescription>
                        {snapshot?.name} ({snapshot?.email}){' '}
                        {snapshot?.enabled
                            ? 'pourra accéder à la console Vectorix et administrer ses utilisateurs, organisations et réglages.'
                            : 'perdra immédiatement l’accès à la console Vectorix.'}
                    </DialogDescription>
                </DialogHeader>
                <p className='text-sm text-muted-foreground'>
                    Le changement sera enregistré dans le journal d’audit.
                </p>
                {error ? (
                    <p role='alert' className='text-sm text-destructive'>
                        {error} Fermez cette fenêtre et rechargez la fiche avant
                        de réessayer.
                    </p>
                ) : null}
                <DialogFooter>
                    <Button
                        variant='outline'
                        disabled={pending}
                        onClick={onClose}
                    >
                        Annuler
                    </Button>
                    <Button
                        disabled={!snapshot || pending || requiresReload}
                        onClick={() => {
                            if (snapshot) onConfirm(snapshot);
                        }}
                    >
                        {pending
                            ? 'Enregistrement…'
                            : snapshot?.enabled
                              ? 'Nommer superadmin'
                              : 'Retirer l’accès'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
