'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { UserRound, Bell, Users, Layers, Database } from 'lucide-react';
import DashboardPage from '@/components/dashboard-page';
const cards = [
    {
        title: 'navigation.collections',
        description: 'home.collections',
        href: '/dashboard/collections',
        icon: Database,
    },
    {
        title: 'navigation.account',
        description: 'home.account',
        href: '/dashboard/account',
        icon: UserRound,
    },
    {
        title: 'navigation.notifications',
        description: 'home.notifications',
        href: '/dashboard/notifications',
        icon: Bell,
    },
    {
        title: 'home.organizationTitle',
        description: 'home.organization',
        href: '/dashboard/settings/members',
        icon: Users,
    },
    {
        title: 'navigation.licenses',
        description: 'home.licenses',
        href: '/dashboard/settings/licenses',
        icon: Layers,
    },
];
export default function Dashboard() {
    const t = useTranslations('dashboard');
    return (
        <DashboardPage>
            <p className='mb-3 text-sm text-muted-foreground'>
                {t('home.eyebrow')}
            </p>
            <h1 className='text-3xl font-semibold tracking-tight'>
                {t('home.welcome')}
            </h1>
            <p className='mt-3 max-w-2xl text-muted-foreground'>
                {t('home.description')}
            </p>
            <div className='mt-10 grid gap-4 md:grid-cols-2'>
                {cards.map((card) => (
                    <Link
                        href={card.href}
                        key={card.href}
                        className='rounded-xl border bg-card p-6 transition-colors hover:border-primary'
                    >
                        <card.icon className='mb-6 h-6 w-6 text-muted-foreground' />
                        <h2 className='text-lg font-medium'>{t(card.title)}</h2>
                        <p className='mt-2 text-sm text-muted-foreground'>
                            {t(card.description)}
                        </p>
                    </Link>
                ))}
            </div>
        </DashboardPage>
    );
}
