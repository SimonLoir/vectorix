'use client';
import DashboardPage from '@/components/dashboard-page';
import { AccountProfile } from './profile';
import { AccountSecurity } from './security';
import { TwoFactorCard } from './two-factor/two-factor-card';
import Link from 'next/link';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
export default function AccountPage() {
    const { data: session, refetch } = useAuth().useSession();
    return (
        <DashboardPage className='space-y-6'>
            <h1 className='text-2xl font-semibold'>Mon compte</h1>
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
                Préférences de notifications
            </Link>
        </DashboardPage>
    );
}
