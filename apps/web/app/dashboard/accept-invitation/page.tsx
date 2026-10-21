'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { toast } from 'sonner';
import PaddedSpinner from '@repo/dashboard-core/components/padded-spinner';
import DashboardPage from '@/components/dashboard-page';
import PageTitle from '@repo/dashboard-core/components/page-title';
import PageDescription from '@repo/dashboard-core/components/page-description';
import { Button } from '@repo/ui/button';
import { useTranslations } from 'next-intl';
import { BreadCrumbs } from '@repo/dashboard-core/components/app-page-context';

function AcceptInvitationContent() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const authClient = useAuth();
    const t = useTranslations('acceptInvitation');
    const tBc = useTranslations('breadcrumbs');
    const [status, setStatus] = useState<
        'loading' | 'accepting' | 'success' | 'error'
    >('loading');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [organizationName, setOrganizationName] = useState<string | null>(
        null
    );

    useEffect(() => {
        const acceptInvitation = async () => {
            const invitationId = searchParams.get('id');

            if (!invitationId) {
                setStatus('error');
                setErrorMessage(t('missingId'));
                return;
            }

            setStatus('accepting');
            try {
                const { data, error } =
                    await authClient.organization.acceptInvitation({
                        invitationId,
                    });

                if (error) {
                    setStatus('error');
                    const message =
                        typeof error.message === 'string'
                            ? error.message
                            : t('failedToAccept');
                    setErrorMessage(message);
                    toast.error(message);
                } else if (data) {
                    setStatus('success');
                    const orgName = data.member?.organizationId
                        ? 'the organization'
                        : 'the organization';
                    setOrganizationName(orgName);
                    toast.success(t('joinedOrganization'));
                    // Redirect to dashboard after a short delay
                    void setTimeout(() => {
                        void router.push('/dashboard');
                    }, 2000);
                }
            } catch {
                setStatus('error');
                setErrorMessage(t('unexpectedError'));
                toast.error(t('failedToAccept'));
            }
        };

        void acceptInvitation();
    }, [searchParams, router, t, authClient.organization]);

    if (status === 'loading' || status === 'accepting') {
        return (
            <DashboardPage>
                <BreadCrumbs
                    breadcrumbs={[
                        { title: tBc('dashboard'), url: '/dashboard' },
                        { title: tBc('acceptInvitation') },
                    ]}
                />
                <div className='flex min-h-[60vh] items-center justify-center'>
                    <div className='text-center space-y-4'>
                        <PaddedSpinner />
                        <p className='text-muted-foreground'>
                            {status === 'loading'
                                ? t('processingInvitation')
                                : t('acceptingInvitation')}
                        </p>
                    </div>
                </div>
            </DashboardPage>
        );
    }

    if (status === 'error') {
        return (
            <DashboardPage className='space-y-6'>
                <BreadCrumbs
                    breadcrumbs={[
                        { title: tBc('dashboard'), url: '/dashboard' },
                        { title: tBc('acceptInvitation') },
                    ]}
                />
                <div>
                    <PageTitle>{t('errorTitle')}</PageTitle>
                    <PageDescription>{t('errorDescription')}</PageDescription>
                </div>

                <div className='flex min-h-[40vh] items-center justify-center'>
                    <div className='text-center space-y-4 max-w-md'>
                        <div className='rounded-full bg-red-100 dark:bg-red-900 p-3 mx-auto w-fit'>
                            <svg
                                className='h-6 w-6 text-red-600 dark:text-red-200'
                                fill='none'
                                viewBox='0 0 24 24'
                                stroke='currentColor'
                            >
                                <path
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                    strokeWidth={2}
                                    d='M6 18L18 6M6 6l12 12'
                                />
                            </svg>
                        </div>
                        <h2 className='text-xl font-semibold'>
                            {t('failedTitle')}
                        </h2>
                        <p className='text-muted-foreground'>{errorMessage}</p>
                        <div className='text-sm text-muted-foreground space-y-1'>
                            <p>{t('invitationMayHave')}</p>
                            <ul className='list-disc list-inside'>
                                <li>{t('expired')}</li>
                                <li>{t('alreadyAccepted')}</li>
                                <li>{t('canceled')}</li>
                            </ul>
                        </div>
                        <Button onClick={() => router.push('/dashboard')}>
                            {t('goToDashboard')}
                        </Button>
                    </div>
                </div>
            </DashboardPage>
        );
    }

    if (status === 'success') {
        return (
            <DashboardPage className='space-y-6'>
                <BreadCrumbs
                    breadcrumbs={[
                        { title: tBc('dashboard'), url: '/dashboard' },
                        { title: tBc('acceptInvitation') },
                    ]}
                />
                <div>
                    <PageTitle>{t('successTitle')}</PageTitle>
                    <PageDescription>{t('successDescription')}</PageDescription>
                </div>

                <div className='flex min-h-[40vh] items-center justify-center'>
                    <div className='text-center space-y-4 max-w-md'>
                        <div className='rounded-full bg-green-100 dark:bg-green-900 p-3 mx-auto w-fit'>
                            <svg
                                className='h-6 w-6 text-green-600 dark:text-green-200'
                                fill='none'
                                viewBox='0 0 24 24'
                                stroke='currentColor'
                            >
                                <path
                                    strokeLinecap='round'
                                    strokeLinejoin='round'
                                    strokeWidth={2}
                                    d='M5 13l4 4L19 7'
                                />
                            </svg>
                        </div>
                        <h2 className='text-xl font-semibold'>
                            {t('welcome')}
                        </h2>
                        <p className='text-muted-foreground'>
                            {t('successfullyJoined')}{' '}
                            <span className='font-medium'>
                                {organizationName}
                            </span>
                            .
                        </p>
                        <p className='text-sm text-muted-foreground'>
                            {t('redirecting')}
                        </p>
                    </div>
                </div>
            </DashboardPage>
        );
    }

    return null;
}

export default function AcceptInvitationPage() {
    return (
        <Suspense fallback={<PaddedSpinner />}>
            <AcceptInvitationContent />
        </Suspense>
    );
}
