'use client';
import { Button } from '@repo/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field';
import { Input } from '@repo/ui/input';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useTranslations } from 'next-intl';
import QRCode from 'qrcode';
import { useState } from 'react';
import { BackupCodesList } from './backup-codes-list';
import { PasswordConfirmForm } from './password-confirm-form';

type SetupState =
    | { step: 'password' }
    | {
          step: 'scan';
          secret: string;
          qrCodeDataUrl: string;
          backupCodes: string[];
      }
    | { step: 'codes'; backupCodes: string[] };

/**
 * Three-step TOTP enrolment: password, scan + first code, backup codes.
 * Better Auth only sets `twoFactorEnabled` once the first TOTP code is
 * verified, so closing the dialog before that leaves 2FA disabled.
 */
export function TwoFactorSetupDialog({
    open,
    onOpenChange,
    onEnabled,
}: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly onEnabled: () => void;
}) {
    const authClient = useAuth();
    const t = useTranslations('account.twoFactor');
    const [state, setState] = useState<SetupState>({ step: 'password' });
    const [code, setCode] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const reset = (nextOpen: boolean) => {
        if (!nextOpen) {
            setState({ step: 'password' });
            setCode('');
            setError(null);
        }
        onOpenChange(nextOpen);
    };

    const startEnrolment = async (password: string) => {
        const { data, error: enableError } = await authClient.twoFactor.enable({
            password,
            issuer: 'Vectorix',
        });
        if (enableError || !data) return t('invalidPassword');
        const secret = new URL(data.totpURI).searchParams.get('secret') ?? '';
        setState({
            step: 'scan',
            secret,
            qrCodeDataUrl: await QRCode.toDataURL(data.totpURI, {
                margin: 1,
                width: 200,
            }),
            backupCodes: data.backupCodes,
        });
        return null;
    };

    const verifyFirstCode = async (backupCodes: string[]) => {
        setPending(true);
        setError(null);
        const { error: verifyError } = await authClient.twoFactor.verifyTotp({
            code: code.trim(),
        });
        setPending(false);
        if (verifyError) {
            setError(t('invalidCode'));
            return;
        }
        setState({ step: 'codes', backupCodes });
        onEnabled();
    };

    return (
        <Dialog open={open} onOpenChange={reset}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{t('setupTitle')}</DialogTitle>
                    <DialogDescription>
                        {state.step === 'password' && t('setupPasswordStep')}
                        {state.step === 'scan' && t('setupScanStep')}
                        {state.step === 'codes' && t('setupCodesStep')}
                    </DialogDescription>
                </DialogHeader>

                {state.step === 'password' && (
                    <PasswordConfirmForm
                        submitLabel={t('continue')}
                        onConfirm={startEnrolment}
                    />
                )}

                {state.step === 'scan' && (
                    <form
                        className='space-y-4'
                        onSubmit={(event) => {
                            event.preventDefault();
                            void verifyFirstCode(state.backupCodes);
                        }}
                    >
                        <div className='flex flex-col items-center gap-3'>
                            {/* eslint-disable-next-line @next/next/no-img-element -- local data URL */}
                            <img
                                src={state.qrCodeDataUrl}
                                alt={t('qrCodeAlt')}
                                width={200}
                                height={200}
                                className='rounded-md border bg-white'
                            />
                            <p className='text-center text-xs text-muted-foreground'>
                                {t('manualSecret')}{' '}
                                <code className='break-all font-mono'>
                                    {state.secret}
                                </code>
                            </p>
                        </div>
                        <Field>
                            <FieldLabel htmlFor='two-factor-setup-code'>
                                {t('codeLabel')}
                            </FieldLabel>
                            <Input
                                id='two-factor-setup-code'
                                autoComplete='one-time-code'
                                inputMode='numeric'
                                pattern='[0-9]{6}'
                                maxLength={6}
                                value={code}
                                onChange={(event) =>
                                    setCode(event.target.value)
                                }
                                aria-invalid={error ? true : undefined}
                                required
                            />
                            {error && (
                                <FieldDescription
                                    className='text-destructive'
                                    role='alert'
                                >
                                    {error}
                                </FieldDescription>
                            )}
                        </Field>
                        <Button type='submit' disabled={pending}>
                            {pending ? t('pending') : t('activate')}
                        </Button>
                    </form>
                )}

                {state.step === 'codes' && (
                    <div className='space-y-4'>
                        <BackupCodesList codes={state.backupCodes} />
                        <Button type='button' onClick={() => reset(false)}>
                            {t('done')}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
