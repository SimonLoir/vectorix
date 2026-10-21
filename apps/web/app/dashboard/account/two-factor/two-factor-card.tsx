'use client';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@repo/ui/card';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { toast } from 'sonner';
import { BackupCodesList } from './backup-codes-list';
import { PasswordConfirmForm } from './password-confirm-form';
import { TwoFactorSetupDialog } from './two-factor-setup-dialog';

type OpenDialog = 'setup' | 'disable' | 'regenerate' | null;

/**
 * Optional TOTP two-factor authentication for the signed-in user. Status comes
 * from the Better Auth session (`user.twoFactorEnabled`); every change asks
 * for the password again and refreshes the session afterwards.
 */
export function TwoFactorCard({
    enabled,
    onChanged,
}: {
    readonly enabled: boolean;
    readonly onChanged: () => void;
}) {
    const authClient = useAuth();
    const t = useTranslations('account.twoFactor');
    const [dialog, setDialog] = useState<OpenDialog>(null);
    const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(
        null
    );

    const closeDialog = () => {
        setDialog(null);
        setRegeneratedCodes(null);
    };

    const disable = async (password: string) => {
        const { error } = await authClient.twoFactor.disable({ password });
        if (error) return t('invalidPassword');
        toast.success(t('disabledToast'));
        closeDialog();
        onChanged();
        return null;
    };

    const regenerate = async (password: string) => {
        const { data, error } = await authClient.twoFactor.generateBackupCodes({
            password,
        });
        if (error || !data) return t('invalidPassword');
        setRegeneratedCodes(data.backupCodes);
        return null;
    };

    return (
        <Card>
            <CardHeader>
                <div className='flex flex-wrap items-center gap-2'>
                    <CardTitle>{t('title')}</CardTitle>
                    <Badge variant={enabled ? 'default' : 'secondary'}>
                        {enabled ? t('statusEnabled') : t('statusDisabled')}
                    </Badge>
                </div>
                <CardDescription>{t('description')}</CardDescription>
            </CardHeader>
            <CardContent className='flex flex-wrap gap-2'>
                {enabled ? (
                    <>
                        <Button
                            variant='outline'
                            onClick={() => setDialog('regenerate')}
                        >
                            <KeyRound className='mr-2 h-4 w-4' />
                            {t('regenerateBackupCodes')}
                        </Button>
                        <Button
                            variant='outline'
                            onClick={() => setDialog('disable')}
                        >
                            <ShieldOff className='mr-2 h-4 w-4' />
                            {t('disable')}
                        </Button>
                    </>
                ) : (
                    <Button onClick={() => setDialog('setup')}>
                        <ShieldCheck className='mr-2 h-4 w-4' />
                        {t('enable')}
                    </Button>
                )}
            </CardContent>

            <TwoFactorSetupDialog
                open={dialog === 'setup'}
                onOpenChange={(open) => setDialog(open ? 'setup' : null)}
                onEnabled={() => {
                    toast.success(t('enabledToast'));
                    onChanged();
                }}
            />

            <Dialog
                open={dialog === 'disable' || dialog === 'regenerate'}
                onOpenChange={(open) => !open && closeDialog()}
            >
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {dialog === 'disable'
                                ? t('disableTitle')
                                : t('regenerateTitle')}
                        </DialogTitle>
                        <DialogDescription>
                            {dialog === 'disable'
                                ? t('disableDescription')
                                : t('regenerateDescription')}
                        </DialogDescription>
                    </DialogHeader>
                    {regeneratedCodes ? (
                        <div className='space-y-4'>
                            <BackupCodesList codes={regeneratedCodes} />
                            <Button type='button' onClick={closeDialog}>
                                {t('done')}
                            </Button>
                        </div>
                    ) : (
                        <PasswordConfirmForm
                            key={dialog}
                            destructive={dialog === 'disable'}
                            submitLabel={
                                dialog === 'disable'
                                    ? t('disable')
                                    : t('regenerateBackupCodes')
                            }
                            onConfirm={
                                dialog === 'disable' ? disable : regenerate
                            }
                        />
                    )}
                </DialogContent>
            </Dialog>
        </Card>
    );
}
