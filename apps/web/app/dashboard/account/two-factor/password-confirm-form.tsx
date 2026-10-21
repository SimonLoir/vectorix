'use client';
import { Button } from '@repo/ui/button';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/field';
import { Input } from '@repo/ui/input';
import { useTranslations } from 'next-intl';
import { useState } from 'react';

/**
 * Password re-authentication required by every Better Auth two-factor
 * mutation (enable, disable, backup-code regeneration). `onConfirm` returns
 * an error message to keep the dialog open, or null on success.
 */
export function PasswordConfirmForm({
    submitLabel,
    destructive = false,
    onConfirm,
}: {
    readonly submitLabel: string;
    readonly destructive?: boolean;
    readonly onConfirm: (password: string) => Promise<string | null>;
}) {
    const t = useTranslations('account.twoFactor');
    const [password, setPassword] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    return (
        <form
            className='space-y-4'
            onSubmit={async (event) => {
                event.preventDefault();
                setPending(true);
                setError(await onConfirm(password));
                setPending(false);
            }}
        >
            <Field>
                <FieldLabel htmlFor='two-factor-password'>
                    {t('passwordLabel')}
                </FieldLabel>
                <Input
                    id='two-factor-password'
                    type='password'
                    autoComplete='current-password'
                    autoFocus
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    required
                />
                {error && (
                    <FieldDescription className='text-destructive' role='alert'>
                        {error}
                    </FieldDescription>
                )}
            </Field>
            <Button
                type='submit'
                variant={destructive ? 'destructive' : 'default'}
                disabled={pending}
            >
                {pending ? t('pending') : submitLabel}
            </Button>
        </form>
    );
}
