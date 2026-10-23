'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import type { SecurityActions } from './security-actions';
import type { SecurityErrorKey } from './security-errors';

/** Retain entered passwords on failure; only a confirmed native change resets the form. */
export function PasswordCard({
    actions,
    onChanged,
}: Readonly<{ actions: SecurityActions; onChanged: () => Promise<unknown> }>) {
    const auth = useAuth();
    const t = useTranslations('accountSecurity');
    const [error, setError] = useState<
        SecurityErrorKey | 'passwordMismatch' | null
    >(null);
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('password.title')}</CardTitle>
            </CardHeader>
            <CardContent>
                <form
                    className='space-y-4'
                    onSubmit={async (event) => {
                        event.preventDefault();
                        const form = event.currentTarget;
                        const data = new FormData(form);
                        const currentPassword = data.get('current');
                        const newPassword = data.get('next');
                        if (
                            typeof currentPassword !== 'string' ||
                            typeof newPassword !== 'string'
                        )
                            return;
                        setError(null);
                        if (newPassword !== data.get('confirm')) {
                            setError('passwordMismatch');
                            return;
                        }
                        const result = await actions.perform(() =>
                            auth.changePassword({
                                currentPassword,
                                newPassword,
                                revokeOtherSessions: true,
                            })
                        );
                        if (!result.success) {
                            setError(result.error);
                            return;
                        }
                        form.reset();
                        toast.success(t('password.changed'));
                        try {
                            await onChanged();
                        } catch {
                            setError('refreshRequired');
                        }
                    }}
                >
                    <p className='text-muted-foreground text-sm'>
                        {t('password.description')}
                    </p>
                    <label className='block space-y-2'>
                        <span>{t('password.current')}</span>
                        <Input
                            name='current'
                            type='password'
                            autoComplete='current-password'
                            placeholder={t('password.currentPlaceholder')}
                            disabled={actions.busy}
                            required
                        />
                    </label>
                    <label className='block space-y-2'>
                        <span>{t('password.next')}</span>
                        <Input
                            name='next'
                            type='password'
                            minLength={8}
                            autoComplete='new-password'
                            placeholder={t('password.nextPlaceholder')}
                            disabled={actions.busy}
                            required
                        />
                    </label>
                    <label className='block space-y-2'>
                        <span>{t('password.confirm')}</span>
                        <Input
                            name='confirm'
                            type='password'
                            autoComplete='new-password'
                            placeholder={t('password.confirmPlaceholder')}
                            disabled={actions.busy}
                            required
                        />
                    </label>
                    {error && (
                        <p role='alert' className='text-destructive text-sm'>
                            {t(`errors.${error}`)}
                        </p>
                    )}
                    <Button type='submit' disabled={actions.busy}>
                        {actions.busy ? t('working') : t('password.submit')}
                    </Button>
                </form>
            </CardContent>
        </Card>
    );
}
