'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import {
    emailOwnershipError,
    emailVerificationOutcome,
    emailVerificationPath,
    type EmailVerificationOutcome,
} from '@repo/dashboard-core/lib/email-ownership';
import { Button } from '@repo/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';

function VerificationAction({
    token,
    returnTo,
    email,
    refresh,
}: Readonly<{
    token: string;
    returnTo: string;
    email: string;
    refresh: () => Promise<unknown>;
}>) {
    const auth = useAuth();
    const router = useRouter();
    const t = useTranslations('verifyEmail');
    const errors = useTranslations('emailOwnershipErrors');
    const [busy, setBusy] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [outcome, setOutcome] = useState<EmailVerificationOutcome | null>(
        null
    );
    const [error, setError] = useState<ReturnType<
        typeof emailOwnershipError
    > | null>(null);
    const [refreshFailed, setRefreshFailed] = useState(false);
    const resume = emailVerificationPath(token, returnTo);
    const signInHref = `/sign-in?${new URLSearchParams({ returnTo: resume ?? '/dashboard/account' })}`;

    return (
        <div className='space-y-4'>
            <p>{t('signedInAs', { email })}</p>
            <p className='text-muted-foreground text-sm'>
                {t('explicitConfirmation')}
            </p>
            {outcome && (
                <div role='status' className='space-y-3'>
                    <p>{t(outcome)}</p>
                    {refreshFailed && <p>{t('refreshFailed')}</p>}
                    <Button asChild>
                        <Link href={returnTo} prefetch={false}>
                            {t('continue')}
                        </Link>
                    </Button>
                </div>
            )}
            {error && (
                <p role='alert' className='text-destructive text-sm'>
                    {errors(error)}
                </p>
            )}
            {!outcome && (
                <Button
                    disabled={busy || switching}
                    onClick={async () => {
                        setBusy(true);
                        setError(null);
                        try {
                            const response = await auth.verifyEmail({
                                query: { token },
                            });
                            if (response.error) {
                                setError(emailOwnershipError(response.error));
                                return;
                            }
                            const result = emailVerificationOutcome(
                                response.data
                            );
                            if (!result) {
                                setError('generic');
                                return;
                            }
                            setOutcome(result);
                            try {
                                await refresh();
                            } catch {
                                setRefreshFailed(true);
                            }
                        } catch {
                            setError('generic');
                        } finally {
                            setBusy(false);
                        }
                    }}
                >
                    {busy ? t('verifying') : t('verify')}
                </Button>
            )}
            {!outcome && (
                <div className='space-y-3 border-t pt-4'>
                    <p className='text-muted-foreground text-sm'>
                        {t('wrongAccount')}
                    </p>
                    <Button
                        variant='outline'
                        disabled={busy || switching}
                        onClick={async () => {
                            setSwitching(true);
                            setError(null);
                            try {
                                const response = await auth.signOut();
                                if (response.error) setError('generic');
                                else router.replace(signInHref);
                            } catch {
                                setError('generic');
                            } finally {
                                setSwitching(false);
                            }
                        }}
                    >
                        {switching ? t('switchingAccount') : t('switchAccount')}
                    </Button>
                    <p>
                        <Link
                            className='text-sm underline'
                            href='/dashboard/account'
                            prefetch={false}
                        >
                            {t('requestNewLink')}
                        </Link>
                    </p>
                </div>
            )}
        </div>
    );
}

/** A public shell lets password, passkey and 2FA sign-in resume the same link. */
export function VerifyEmail({
    token,
    returnTo,
}: Readonly<{ token: string | null; returnTo: string }>) {
    const { data: session, isPending, error, refetch } = useAuth().useSession();
    const t = useTranslations('verifyEmail');
    const ownership = useTranslations('emailOwnership');
    const resume = token ? emailVerificationPath(token, returnTo) : null;
    return (
        <Card>
            <CardHeader>
                <CardTitle>{t('title')}</CardTitle>
            </CardHeader>
            <CardContent className='space-y-4'>
                {token && resume ? (
                    isPending ? (
                        <p role='status'>{ownership('loadingSession')}</p>
                    ) : error ? (
                        <>
                            <p role='alert'>{ownership('sessionError')}</p>
                            <Button
                                variant='outline'
                                onClick={() => {
                                    void refetch();
                                }}
                            >
                                {ownership('reloadSession')}
                            </Button>
                        </>
                    ) : session ? (
                        <VerificationAction
                            key={`${session.session.id}:${session.user.id}`}
                            token={token}
                            returnTo={returnTo}
                            email={session.user.email}
                            refresh={refetch}
                        />
                    ) : (
                        <>
                            <p>{t('signInRequired')}</p>
                            <Button asChild>
                                <Link
                                    href={`/sign-in?${new URLSearchParams({ returnTo: resume })}`}
                                    prefetch={false}
                                >
                                    {t('signIn')}
                                </Link>
                            </Button>
                        </>
                    )
                ) : (
                    <>
                        <p role='alert'>{t('invalidLink')}</p>
                        <Link
                            href='/dashboard/account'
                            className='underline'
                            prefetch={false}
                        >
                            {t('requestNewLink')}
                        </Link>
                    </>
                )}
            </CardContent>
        </Card>
    );
}
