import Link from 'next/link';
import { UserRound, Bell, Users, Layers, Database } from 'lucide-react';
import DashboardPage from '@/components/dashboard-page';
const cards = [
    {
        title: 'Collections',
        description: 'Profils de recherche, configuration et droits d’accès.',
        href: '/dashboard/collections',
        icon: Database,
    },
    {
        title: 'Mon compte',
        description: 'Profil, mot de passe, passkeys et sécurité.',
        href: '/dashboard/account',
        icon: UserRound,
    },
    {
        title: 'Notifications',
        description: 'Votre activité et vos préférences de réception.',
        href: '/dashboard/notifications',
        icon: Bell,
    },
    {
        title: 'Organisation',
        description: 'Membres, invitations et rôles de votre équipe.',
        href: '/dashboard/settings/members',
        icon: Users,
    },
    {
        title: 'Licences',
        description: 'Fonctionnalités activées pour votre organisation.',
        href: '/dashboard/settings/licenses',
        icon: Layers,
    },
];
export default function Dashboard() {
    return (
        <DashboardPage>
            <p className='mb-3 text-sm text-muted-foreground'>
                ESPACE DE TRAVAIL
            </p>
            <h1 className='text-3xl font-semibold tracking-tight'>
                Bienvenue sur Vectorix
            </h1>
            <p className='mt-3 max-w-2xl text-muted-foreground'>
                Votre espace pour gérer votre compte et votre équipe.
            </p>
            <div className='mt-10 grid gap-4 md:grid-cols-2'>
                {cards.map((card) => (
                    <Link
                        href={card.href}
                        key={card.href}
                        className='rounded-xl border bg-card p-6 transition-colors hover:border-primary'
                    >
                        <card.icon className='mb-6 h-6 w-6 text-muted-foreground' />
                        <h2 className='text-lg font-medium'>{card.title}</h2>
                        <p className='mt-2 text-sm text-muted-foreground'>
                            {card.description}
                        </p>
                    </Link>
                ))}
            </div>
        </DashboardPage>
    );
}
