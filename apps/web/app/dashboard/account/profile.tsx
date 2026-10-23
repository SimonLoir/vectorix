'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { emailOwnershipError } from '@repo/dashboard-core/lib/email-ownership';
import { Button } from '@repo/ui/button';
import { Input } from '@repo/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui/card';
import { EmailVerificationRequest } from '@/components/email-verification-request';

function ProfileForms({
    user,
    onChanged,
}: Readonly<{
    user: { name: string; email: string; emailVerified: boolean };
    onChanged: () => Promise<unknown>;
}>) {
    const auth = useAuth();
    const t = useTranslations('account.profile');
    const errors = useTranslations('emailOwnershipErrors');
    const [nameBusy, setNameBusy] = useState(false);
    const [nameResult, setNameResult] = useState<'saved' | 'error' | null>(
        null
    );
    const [emailBusy, setEmailBusy] = useState(false);
    const [emailRequested, setEmailRequested] = useState(false);
    const [emailError, setEmailError] = useState<ReturnType<
        typeof emailOwnershipError
    > | null>(null);

    return (
        <>
            <Card>
                <CardHeader>
                    <CardTitle>{t('title')}</CardTitle>
                </CardHeader>
                <CardContent>
                    <form
                        className='space-y-4'
                        onSubmit={async (event) => {
                            event.preventDefault();
                            const name = new FormData(event.currentTarget).get(
                                'name'
                            );
                            if (typeof name !== 'string') return;
                            setNameBusy(true);
                            setNameResult(null);
                            try {
                                const response = await auth.updateUser({
                                    name,
                                });
                                if (response.error) setNameResult('error');
                                else {
                                    await onChanged();
                                    setNameResult('saved');
                                }
                            } catch {
                                setNameResult('error');
                            } finally {
                                setNameBusy(false);
                            }
                        }}
                    >
                        <label className='block space-y-2'>
                            <span>{t('name')}</span>
                            <Input
                                name='name'
                                autoComplete='name'
                                defaultValue={user.name}
                                disabled={nameBusy}
                                onChange={() => {
                                    setNameResult(null);
                                }}
                                required
                                maxLength={200}
                            />
                        </label>
                        {nameResult === 'saved' && (
                            <p role='status' className='text-sm'>
                                {t('nameSaved')}
                            </p>
                        )}
                        {nameResult === 'error' && (
                            <p
                                role='alert'
                                className='text-destructive text-sm'
                            >
                                {t('nameError')}
                            </p>
                        )}
                        <Button disabled={nameBusy}>
                            {nameBusy ? t('savingName') : t('saveName')}
                        </Button>
                    </form>
                </CardContent>
            </Card>
            <Card>
                <CardHeader>
                    <CardTitle>{t('emailTitle')}</CardTitle>
                </CardHeader>
                <CardContent className='space-y-6'>
                    <div className='space-y-2'>
                        <p className='break-all font-medium'>{user.email}</p>
                        <p className='text-sm'>
                            {user.emailVerified
                                ? t('verified')
                                : t('unverified')}
                        </p>
                        {!user.emailVerified && (
                            <EmailVerificationRequest
                                email={user.email}
                                callbackURL='/dashboard/account'
                            />
                        )}
                    </div>
                    <form
                        className='space-y-4 border-t pt-6'
                        onSubmit={async (event) => {
                            event.preventDefault();
                            if (!user.emailVerified) {
                                setEmailError('currentAddressRequired');
                                return;
                            }
                            const newEmail = new FormData(
                                event.currentTarget
                            ).get('newEmail');
                            if (typeof newEmail !== 'string') return;
                            setEmailBusy(true);
                            setEmailError(null);
                            setEmailRequested(false);
                            try {
                                const response = await auth.changeEmail({
                                    newEmail,
                                    callbackURL: '/dashboard/account',
                                });
                                if (response.error)
                                    setEmailError(
                                        emailOwnershipError(response.error)
                                    );
                                else setEmailRequested(true);
                            } catch {
                                setEmailError('generic');
                            } finally {
                                setEmailBusy(false);
                            }
                        }}
                    >
                        <label className='block space-y-2'>
                            <span>{t('newEmail')}</span>
                            <Input
                                name='newEmail'
                                type='email'
                                autoComplete='email'
                                required
                                maxLength={254}
                                disabled={emailBusy || !user.emailVerified}
                                onChange={() => {
                                    setEmailRequested(false);
                                    setEmailError(null);
                                }}
                            />
                        </label>
                        <p className='text-muted-foreground text-sm'>
                            {user.emailVerified
                                ? t('changeVerifiedHelp')
                                : t('changeUnverifiedHelp')}
                        </p>
                        {emailRequested && (
                            <p role='status' className='text-sm'>
                                {t('changeVerifiedRequested')}
                            </p>
                        )}
                        {emailError && (
                            <p
                                role='alert'
                                className='text-destructive text-sm'
                            >
                                {errors(emailError)}
                            </p>
                        )}
                        <Button disabled={emailBusy || !user.emailVerified}>
                            {emailBusy
                                ? t('requestingChange')
                                : t('requestChange')}
                        </Button>
                    </form>
                </CardContent>
            </Card>
        </>
    );
}

/** Account fields and address-proof actions have independent submission state. */
export function AccountProfile() {
    const { data: session, isPending, error, refetch } = useAuth().useSession();
    const t = useTranslations('emailOwnership');
    if (isPending) return <p role='status'>{t('loadingSession')}</p>;
    if (error || !session)
        return (
            <div role='alert' className='space-y-3'>
                <p>{t('sessionError')}</p>
                <Button
                    variant='outline'
                    onClick={() => {
                        void refetch();
                    }}
                >
                    {t('reloadSession')}
                </Button>
            </div>
        );
    return (
        <ProfileForms
            key={`${session.session.id}:${session.user.email}:${session.user.emailVerified}`}
            user={session.user}
            onChanged={refetch}
        />
    );
}
