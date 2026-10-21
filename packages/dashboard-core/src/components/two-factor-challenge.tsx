'use client';
import { Button } from '@repo/ui/button';
import { Checkbox } from '@repo/ui/checkbox';
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
} from '@repo/ui/field';
import { Input } from '@repo/ui/input';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '../hooks/use-auth';

type ChallengeMode = 'totp' | 'backupCode';

/**
 * Second sign-in step shown after a credential sign-in answered
 * `twoFactorRedirect`. The pending challenge lives in Better Auth's signed
 * two-factor cookie (10 minutes); verifying a TOTP or a single-use backup code
 * creates the real session. Errors keep the typed code so the user can retry.
 */
export function TwoFactorChallenge({
    onVerified,
    onCancel,
}: {
    readonly onVerified: () => void;
    readonly onCancel: () => void;
}) {
    const authClient = useAuth();
    const t = useTranslations('login.twoFactor');
    const [mode, setMode] = useState<ChallengeMode>('totp');
    const [code, setCode] = useState('');
    const [trustDevice, setTrustDevice] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const input = { code: code.trim(), trustDevice };
        const result =
            mode === 'totp'
                ? await authClient.twoFactor.verifyTotp(input)
                : await authClient.twoFactor.verifyBackupCode(input);
        setPending(false);
        if (result.error) {
            setError(t('invalidCode'));
            return;
        }
        onVerified();
    };

    const switchMode = () => {
        setMode(mode === 'totp' ? 'backupCode' : 'totp');
        setCode('');
        setError(null);
    };

    return (
        <form className='p-6 md:p-8' onSubmit={submit}>
            <FieldGroup>
                <div className='flex flex-col items-center gap-2 text-center'>
                    <h1 className='text-2xl font-bold'>{t('title')}</h1>
                    <p className='text-muted-foreground text-balance'>
                        {mode === 'totp'
                            ? t('totpDescription')
                            : t('backupCodeDescription')}
                    </p>
                </div>
                <Field>
                    <FieldLabel htmlFor='two-factor-code'>
                        {mode === 'totp'
                            ? t('totpLabel')
                            : t('backupCodeLabel')}
                    </FieldLabel>
                    <Input
                        id='two-factor-code'
                        autoComplete='one-time-code'
                        autoFocus
                        inputMode={mode === 'totp' ? 'numeric' : 'text'}
                        maxLength={mode === 'totp' ? 6 : 32}
                        pattern={mode === 'totp' ? '[0-9]{6}' : undefined}
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        aria-invalid={error ? true : undefined}
                        aria-describedby={
                            error ? 'two-factor-error' : undefined
                        }
                        required
                    />
                    {error && (
                        <FieldDescription
                            id='two-factor-error'
                            className='text-destructive'
                            role='alert'
                        >
                            {error}
                        </FieldDescription>
                    )}
                </Field>
                <Field orientation='horizontal'>
                    <Checkbox
                        id='two-factor-trust-device'
                        checked={trustDevice}
                        onCheckedChange={(checked) =>
                            setTrustDevice(checked === true)
                        }
                    />
                    <FieldLabel
                        htmlFor='two-factor-trust-device'
                        className='font-normal'
                    >
                        {t('trustDevice')}
                    </FieldLabel>
                </Field>
                <Field>
                    <Button type='submit' disabled={pending}>
                        {pending ? t('verifying') : t('verify')}
                    </Button>
                    <Button type='button' variant='link' onClick={switchMode}>
                        {mode === 'totp' ? t('useBackupCode') : t('useTotp')}
                    </Button>
                    <Button type='button' variant='ghost' onClick={onCancel}>
                        {t('back')}
                    </Button>
                </Field>
            </FieldGroup>
        </form>
    );
}
