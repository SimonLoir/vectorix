'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    Home,
    Users,
    Shield,
    Bell,
    UserRound,
    KeyRound,
    Layers,
} from 'lucide-react';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
} from '@repo/ui/sidebar';
import { TeamSwitcher } from '@repo/dashboard-core/components/team-switcher';
import { NavUser } from '@repo/dashboard-core/components/nav-user';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { LanguageSwitcher } from '@/components/language-switcher';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
const navigation = [
    { href: '/dashboard', label: 'Accueil', icon: Home },
    { href: '/dashboard/account', label: 'Mon compte', icon: UserRound },
    { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
    {
        href: '/dashboard/settings/members',
        label: 'Membres',
        icon: Users,
        operation: 'admin.members.get',
    },
    {
        href: '/dashboard/settings/roles',
        label: 'Rôles et permissions',
        icon: Shield,
        permission: { ac: ['read'] },
    },
    {
        href: '/dashboard/account/api-keys',
        label: 'Clés API',
        icon: KeyRound,
        operation: 'admin.organization.apiKeys.list',
    },
    { href: '/dashboard/settings/licenses', label: 'Licences', icon: Layers },
];
export function AppSidebar({
    allowOrganizationCreation,
}: {
    readonly allowOrganizationCreation: boolean;
}) {
    const { data: session } = useAuth().useSession();
    const pathname = usePathname();
    const t = useTranslations('navUser');
    const { canOperation, can } = useVectorixPermissions();
    return (
        <Sidebar>
            <SidebarHeader>
                <Link
                    href='/dashboard'
                    className='px-3 py-4 text-xl font-semibold tracking-tight'
                >
                    Vectorix
                </Link>
                <TeamSwitcher
                    allowOrganizationCreation={allowOrganizationCreation}
                />
            </SidebarHeader>
            <SidebarContent>
                <SidebarMenu className='p-2'>
                    {navigation
                        .filter(
                            (item) =>
                                (!item.operation ||
                                    canOperation(item.operation)) &&
                                (!item.permission || can(item.permission))
                        )
                        .map((item) => (
                            <SidebarMenuItem key={item.href}>
                                <SidebarMenuButton
                                    asChild
                                    isActive={pathname === item.href}
                                >
                                    <Link href={item.href}>
                                        <item.icon />
                                        <span>{item.label}</span>
                                    </Link>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        ))}
                </SidebarMenu>
            </SidebarContent>
            <SidebarFooter>
                {session && (
                    <NavUser
                        user={session.user}
                        labels={{
                            account: t('account'),
                            apiKeys: t('apiKeys'),
                            notificationPreferences: t(
                                'notificationPreferences'
                            ),
                            logOut: t('logOut'),
                            loggedOut: t('loggedOut'),
                        }}
                        languageSwitcher={<LanguageSwitcher />}
                        notificationPreferencesPath='/dashboard/notifications/preferences'
                        signOutRedirectPath='/sign-in'
                    />
                )}
            </SidebarFooter>
        </Sidebar>
    );
}
