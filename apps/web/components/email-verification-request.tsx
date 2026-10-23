'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import {
    emailOwnershipCallback,
    emailOwnershipError,
} from '@repo/dashboard-core/lib/email-ownership';
import { Button } from '@repo/ui/button';

/** Sends a new proof to the signed-in account, preserving an allowlisted return. */
export function EmailVerificationRequest({
    email,
    callbackURL,
}: Readonly<{ email: string; callbackURL: string }>) {
    const auth = useAuth();
    const t = useTranslations('emailOwnership');
    const errors = useTranslations('emailOwnershipErrors');
    const [busy, setBusy] = useState(false);
    const [result, setResult] = useState<'sent' | null>(null);
    const [error, setError] = useState<ReturnType<
        typeof emailOwnershipError
    > | null>(null);

    return (
        <div className='space-y-3'>
            <p className='text-muted-foreground text-sm'>
                {t('verifyCurrentDescription', { email })}
            </p>
            {result && (
                <p role='status' className='text-sm'>
                    {t('verificationSent')}
                </p>
            )}
            {error && (
                <p role='alert' className='text-destructive text-sm'>
                    {errors(error)}
                </p>
            )}
            <Button
                type='button'
                variant='outline'
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    setResult(null);
                    try {
                        const callback = emailOwnershipCallback(callbackURL);
                        if (!callback) {
                            setError('generic');
                            return;
                        }
                        const response = await auth.sendVerificationEmail({
                            email,
                            callbackURL: callback,
                        });
                        if (response.error)
                            setError(emailOwnershipError(response.error));
                        else setResult('sent');
                    } catch {
                        setError('generic');
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {busy ? t('sending') : t('sendVerification')}
            </Button>
        </div>
    );
}
