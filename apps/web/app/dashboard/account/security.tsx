'use client';

import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { Button } from '@repo/ui/button';
import Link from 'next/link';
import { PasswordCard } from './security/password-card';
import { PasskeysCard } from './security/passkeys-card';
import { SessionsCard } from './security/sessions-card';
import { DeleteAccountCard } from './security/delete-account-card';
import { useSecurityActions } from './security/security-actions';

function AccountSecurityContent({
    userId,
    sessionId,
    onChanged,
}: Readonly<{
    userId: string;
    sessionId: string;
    onChanged: () => Promise<unknown>;
}>) {
    const actions = useSecurityActions();
    return (
        <>
            <PasswordCard actions={actions} onChanged={onChanged} />
            <PasskeysCard
                actions={actions}
                userId={userId}
                sessionId={sessionId}
            />
            <SessionsCard
                actions={actions}
                userId={userId}
                sessionId={sessionId}
            />
            <DeleteAccountCard actions={actions} />
        </>
    );
}

/** Scope security reads, drafts and confirmations to the current native account session. */
export function AccountSecurity() {
    const { data: session, isPending, error, refetch } = useAuth().useSession();
    const t = useTranslations('accountSecurity');
    if (isPending) return <p role='status'>{t('loadingAccount')}</p>;
    if (error || !session)
        return (
            <div className='space-y-3'>
                <p role='alert'>{t('sessionError')}</p>
                <Button
                    type='button'
                    variant='outline'
                    onClick={() => {
                        void refetch();
                    }}
                >
                    {t('reload')}
                </Button>
                <Button asChild variant='outline'>
                    <Link
                        href='/sign-in?returnTo=%2Fdashboard%2Faccount'
                        prefetch={false}
                    >
                        {t('signIn')}
                    </Link>
                </Button>
            </div>
        );
    return (
        <AccountSecurityContent
            key={`${session.user.id}:${session.session.id}`}
            userId={session.user.id}
            sessionId={session.session.id}
            onChanged={refetch}
        />
    );
}
