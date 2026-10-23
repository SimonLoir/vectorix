'use client';
import DashboardPage from '@/components/dashboard-page';
import { AccountProfile } from './profile';
import { AccountSecurity } from './security';
import { TwoFactorCard } from './two-factor/two-factor-card';
import Link from 'next/link';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useTranslations } from 'next-intl';
export default function AccountPage() {
    const { data: session, refetch } = useAuth().useSession();
    const t = useTranslations('account');
    return (
        <DashboardPage className='space-y-6'>
            <h1 className='text-2xl font-semibold'>{t('title')}</h1>
            <AccountProfile />
            <AccountSecurity />
            <TwoFactorCard
                enabled={session?.user.twoFactorEnabled === true}
                onChanged={() => {
                    void refetch();
                }}
            />
            <Link
                className='inline-block underline'
                href='/dashboard/notifications/preferences'
            >
                {t('notificationPreferences')}
            </Link>
        </DashboardPage>
    );
}
