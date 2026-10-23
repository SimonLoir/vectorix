'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import {
    emailOwnershipError,
    invitationReviewPath,
    requiresInvitationVerification,
} from '@repo/dashboard-core/lib/email-ownership';
import { BreadCrumbs } from '@repo/dashboard-core/components/app-page-context';
import { Button } from '@repo/ui/button';
import DashboardPage from '@/components/dashboard-page';
import { EmailVerificationRequest } from '@/components/email-verification-request';

type InvitationDetails = {
    organizationName: string;
    email: string;
    role: string;
};

function InvitationAction({
    invitationId,
    email,
    verified,
}: Readonly<{ invitationId: string; email: string; verified: boolean }>) {
    const auth = useAuth();
    const t = useTranslations('acceptInvitation');
    const errors = useTranslations('emailOwnershipErrors');
    const [details, setDetails] = useState<InvitationDetails | null>(null);
    const [loading, setLoading] = useState(verified);
    const [busy, setBusy] = useState(false);
    const [verificationRequired, setVerificationRequired] = useState(!verified);
    const [error, setError] = useState<ReturnType<
        typeof emailOwnershipError
    > | null>(null);
    const [reload, setReload] = useState(0);
    const callbackURL = invitationReviewPath(invitationId);

    useEffect(() => {
        if (!verified) return;
        let current = true;
        const load = async () => {
            setLoading(true);
            setDetails(null);
            setError(null);
            try {
                const response = await auth.organization.getInvitation({
                    query: { id: invitationId },
                });
                if (!current) return;
                if (response.error) {
                    if (requiresInvitationVerification(response.error))
                        setVerificationRequired(true);
                    else setError(emailOwnershipError(response.error));
                } else if (response.data) {
                    setDetails({
                        organizationName: response.data.organizationName,
                        email: response.data.email,
                        role: response.data.role,
                    });
                } else setError('generic');
            } catch {
                if (current) setError('generic');
            } finally {
                if (current) setLoading(false);
            }
        };
        void load();
        return () => {
            current = false;
        };
    }, [auth, invitationId, verified, reload]);

    if (!callbackURL) return <p role='alert'>{t('missingId')}</p>;
    if (verificationRequired)
        return (
            <div className='space-y-4'>
                <p>{t('verifyBeforeReview')}</p>
                <EmailVerificationRequest
                    email={email}
                    callbackURL={callbackURL}
                />
                <p className='text-muted-foreground text-sm'>
                    {t('returnAfterVerification')}
                </p>
            </div>
        );
    if (loading) return <p role='status'>{t('loadingDetails')}</p>;
    if (error || !details)
        return (
            <div className='space-y-4'>
                <p role='alert' className='text-destructive'>
                    {error ? errors(error) : t('failedToAccept')}
                </p>
                <p className='text-muted-foreground text-sm'>
                    {t('unavailableHelp')}
                </p>
                <Button
                    variant='outline'
                    onClick={() => {
                        setReload((value) => value + 1);
                    }}
                >
                    {t('reloadInvitation')}
                </Button>
                <p>
                    <Link className='underline' href='/dashboard/account'>
                        {t('accountLink')}
                    </Link>
                </p>
            </div>
        );
    return (
        <div className='space-y-4'>
            <p>
                {t('reviewDescription', {
                    organization: details.organizationName,
                })}
            </p>
            <dl className='grid gap-2 text-sm'>
                <div>
                    <dt className='text-muted-foreground'>{t('recipient')}</dt>
                    <dd className='break-all'>{details.email}</dd>
                </div>
                <div>
                    <dt className='text-muted-foreground'>{t('role')}</dt>
                    <dd className='break-all'>{details.role}</dd>
                </div>
            </dl>
            <p className='text-muted-foreground text-sm'>
                {t('explicitAcceptance')}
            </p>
            <Button
                disabled={busy}
                onClick={async () => {
                    setBusy(true);
                    setError(null);
                    try {
                        const response =
                            await auth.organization.acceptInvitation({
                                invitationId,
                            });
                        if (response.error) {
                            if (requiresInvitationVerification(response.error))
                                setVerificationRequired(true);
                            else setError(emailOwnershipError(response.error));
                            return;
                        }
                        if (!response.data) {
                            setError('generic');
                            return;
                        }
                        // Native acceptance sets the active organisation but does
                        // not invalidate the cached organisation list. Reload the
                        // document to refresh both tenant and membership state.
                        globalThis.location.assign('/dashboard');
                    } catch {
                        setError('generic');
                    } finally {
                        setBusy(false);
                    }
                }}
            >
                {busy ? t('acceptingInvitation') : t('accept')}
            </Button>
            <Button asChild variant='outline'>
                <Link href='/dashboard'>{t('cancel')}</Link>
            </Button>
        </div>
    );
}

/** Reading an invitation never accepts it or changes the active organisation. */
export function InvitationReview({
    invitationId,
}: Readonly<{ invitationId: string | null }>) {
    const { data: session, isPending, error, refetch } = useAuth().useSession();
    const t = useTranslations('acceptInvitation');
    const bc = useTranslations('breadcrumbs');
    const ownership = useTranslations('emailOwnership');
    return (
        <DashboardPage className='space-y-6'>
            <BreadCrumbs
                breadcrumbs={[
                    { title: bc('dashboard'), url: '/dashboard' },
                    { title: bc('acceptInvitation') },
                ]}
            />
            <h1 className='text-2xl font-semibold'>{t('reviewTitle')}</h1>
            <div className='max-w-xl space-y-4'>
                {invitationId ? (
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
                        <InvitationAction
                            key={`${session.session.id}:${invitationId}:${session.user.email}:${session.user.emailVerified}`}
                            invitationId={invitationId}
                            email={session.user.email}
                            verified={session.user.emailVerified}
                        />
                    ) : (
                        <Button asChild>
                            <Link
                                href={`/sign-in?${new URLSearchParams({ returnTo: invitationReviewPath(invitationId) ?? '/dashboard/account' })}`}
                                prefetch={false}
                            >
                                {t('signIn')}
                            </Link>
                        </Button>
                    )
                ) : (
                    <p role='alert'>{t('missingId')}</p>
                )}
            </div>
        </DashboardPage>
    );
}
