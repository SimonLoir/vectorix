'use client';

import { useTranslations } from 'next-intl';
import { BreadCrumbs } from '@repo/dashboard-core/components/app-page-context';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import PaddedSpinner from '@repo/dashboard-core/components/padded-spinner';
import DashboardPage from '@/components/dashboard-page';
import { NotificationPreferences } from '@/components/notifications/notification-preferences';

/** Personal channel choices for the active organization, outside the account page. */
export default function NotificationPreferencesPage() {
    const t = useTranslations('notifications');
    const breadcrumbs = useTranslations('breadcrumbs');
    const { data: session, isPending } = useAuth().useSession();
    const organizationId = session?.session.activeOrganizationId;

    return (
        <DashboardPage className='space-y-6'>
            <BreadCrumbs
                breadcrumbs={[
                    { title: breadcrumbs('dashboard'), url: '/dashboard' },
                    { title: t('title'), url: '/dashboard/notifications' },
                    { title: t('preferences.title') },
                ]}
            />
            {isPending ? <PaddedSpinner /> : null}
            {session && organizationId ? (
                <NotificationPreferences
                    key={`${session.user.id}:${session.session.id}:${organizationId}`}
                    organizationId={organizationId}
                    userId={session.user.id}
                    sessionId={session.session.id}
                />
            ) : null}
        </DashboardPage>
    );
}
