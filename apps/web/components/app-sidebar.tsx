'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupContent,
    SidebarGroupLabel,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarRail,
} from '@repo/ui/sidebar';
import { TeamSwitcher } from '@repo/dashboard-core/components/team-switcher';
import { NavUser } from '@repo/dashboard-core/components/nav-user';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { LanguageSwitcher } from '@/components/language-switcher';
import { BrandMark } from '@/components/shell/brand-mark';
import {
    matchNavigationItem,
    navigationGroups,
} from '@/components/shell/navigation';
import { useVisibleNavigation } from '@/components/shell/use-visible-navigation';

/**
 * Dashboard sidebar grouped by intent: workspace, library, organization and
 * platform. Personal destinations live in the user menu and command palette.
 */
export function AppSidebar({
    allowOrganizationCreation,
}: {
    readonly allowOrganizationCreation: boolean;
}) {
    const { data: session } = useAuth().useSession();
    const pathname = usePathname();
    const t = useTranslations('navUser');
    const nav = useTranslations('dashboard.navigation');
    const items = useVisibleNavigation();
    const active = matchNavigationItem(pathname);

    return (
        <Sidebar collapsible='icon'>
            <SidebarHeader className='gap-3'>
                <Link
                    href='/dashboard'
                    className='flex h-9 items-center gap-2.5 rounded-md px-2 text-[15px] font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:px-0'
                >
                    <BrandMark className='size-6 shrink-0' />
                    <span className='group-data-[collapsible=icon]:hidden'>
                        Vectorix
                    </span>
                </Link>
                <TeamSwitcher
                    allowOrganizationCreation={allowOrganizationCreation}
                    showEmptyOrganizationOnboarding={
                        pathname !== '/dashboard/accept-invitation' &&
                        pathname !== '/dashboard/account'
                    }
                />
            </SidebarHeader>
            <SidebarContent>
                {navigationGroups.map((group) => {
                    const groupItems = items.filter(
                        (item) => item.group === group
                    );
                    if (groupItems.length === 0) return null;
                    return (
                        <SidebarGroup key={group} className='py-1'>
                            {group === 'workspace' ? null : (
                                <SidebarGroupLabel>
                                    {nav(`sections.${group}`)}
                                </SidebarGroupLabel>
                            )}
                            <SidebarGroupContent>
                                <SidebarMenu>
                                    {groupItems.map((item) => (
                                        <SidebarMenuItem key={item.href}>
                                            <SidebarMenuButton
                                                asChild
                                                isActive={
                                                    active?.href === item.href
                                                }
                                                tooltip={nav(item.label)}
                                            >
                                                <Link href={item.href}>
                                                    <item.icon aria-hidden='true' />
                                                    <span>
                                                        {nav(item.label)}
                                                    </span>
                                                </Link>
                                            </SidebarMenuButton>
                                        </SidebarMenuItem>
                                    ))}
                                </SidebarMenu>
                            </SidebarGroupContent>
                        </SidebarGroup>
                    );
                })}
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
            <SidebarRail />
        </Sidebar>
    );
}
