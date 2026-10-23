'use client';

import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import type { SecurityActions } from './security-actions';
import type { SecurityErrorKey } from './security-errors';
import { SecurityConfirmationDialog } from './security-confirmation-dialog';

/** Keep native password and deletion guards; navigate only after confirmed success. */
export function DeleteAccountCard({
    actions,
}: Readonly<{ actions: SecurityActions }>) {
    const auth = useAuth();
    const t = useTranslations('accountSecurity');
    const [open, setOpen] = useState(false);
    const [password, setPassword] = useState('');
    const [error, setError] = useState<SecurityErrorKey | null>(null);
    const trigger = useRef<HTMLButtonElement | null>(null);
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('deletion.title')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-4'>
                <p className='text-muted-foreground text-sm'>
                    {t('deletion.description')}
                </p>
                <Button
                    ref={trigger}
                    type='button'
                    variant='destructive'
                    disabled={actions.busy}
                    onClick={() => {
                        setPassword('');
                        setError(null);
                        setOpen(true);
                    }}
                >
                    {t('deletion.open')}
                </Button>
                <SecurityConfirmationDialog
                    open={open}
                    onOpenChange={(next) => {
                        setOpen(next);
                        if (!next) {
                            setPassword('');
                            setError(null);
                        }
                    }}
                    title={t('deletion.confirmTitle')}
                    description={t('deletion.confirmDescription')}
                    confirmLabel={t('deletion.confirm')}
                    busy={actions.busy}
                    error={error}
                    returnFocus={() => {
                        trigger.current?.focus();
                    }}
                    onConfirm={async () => {
                        if (!password) return;
                        setError(null);
                        const result = await actions.perform(() =>
                            auth.deleteUser({ password })
                        );
                        if (!result.success) {
                            setError(result.error);
                            return;
                        }
                        setPassword('');
                        globalThis.location.assign('/sign-in');
                    }}
                >
                    <label className='block space-y-2'>
                        <span>{t('deletion.password')}</span>
                        <Input
                            name='deleteAccountPassword'
                            type='password'
                            autoComplete='current-password'
                            placeholder={t('deletion.passwordPlaceholder')}
                            value={password}
                            onChange={(event) => {
                                setPassword(event.target.value);
                            }}
                            disabled={actions.busy}
                            required
                        />
                    </label>
                </SecurityConfirmationDialog>
            </CardContent>
        </Card>
    );
}
