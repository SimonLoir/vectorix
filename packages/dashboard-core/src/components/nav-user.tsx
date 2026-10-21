'use client';

import {
    BadgeCheck,
    BellRing,
    ChevronsUpDown,
    KeyRound,
    LogOut,
} from 'lucide-react';

import { PersonAvatar, type PersonAvatarColor } from './person-avatar';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu';
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from '@repo/ui/sidebar';
import { useAuth } from '../hooks/use-auth';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import type { ReactNode } from 'react';

export interface NavUserLabels {
    account: string;
    apiKeys: string;
    /** Shown only when `notificationPreferencesPath` is provided. */
    notificationPreferences?: string;
    logOut: string;
    loggedOut: string;
}

const defaultLabels: NavUserLabels = {
    account: 'Account',
    apiKeys: 'API Keys',
    logOut: 'Log out',
    loggedOut: 'Logged out',
};

export function NavUser({
    user,
    avatarColor,
    languageSwitcher,
    labels = defaultLabels,
    accountPath = '/dashboard/account',
    apiKeysPath = '/dashboard/account/api-keys',
    notificationPreferencesPath,
    signOutRedirectPath = '/',
}: Readonly<{
    user: {
        name: string;
        email: string;
        image?: string | null;
    };
    avatarColor?: PersonAvatarColor | null;
    languageSwitcher?: ReactNode;
    labels?: NavUserLabels;
    accountPath?: string;
    apiKeysPath?: string;
    notificationPreferencesPath?: string;
    signOutRedirectPath?: string;
}>) {
    const { isMobile } = useSidebar();
    const router = useRouter();
    const authClient = useAuth();
    return (
        <SidebarMenu>
            <SidebarMenuItem>
                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <SidebarMenuButton
                            size='lg'
                            className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
                        >
                            <PersonAvatar
                                name={user.name}
                                image={user.image}
                                color={avatarColor}
                                className='h-8 w-8 rounded-lg'
                                fallbackClassName='rounded-lg'
                                decorative
                            />
                            <div className='grid flex-1 text-left text-sm leading-tight'>
                                <span className='truncate font-medium'>
                                    {user.name}
                                </span>
                                <span className='truncate text-xs'>
                                    {user.email}
                                </span>
                            </div>
                            <ChevronsUpDown className='ml-auto size-4' />
                        </SidebarMenuButton>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent
                        className='w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg'
                        side={isMobile ? 'bottom' : 'right'}
                        align='end'
                        sideOffset={4}
                    >
                        <DropdownMenuLabel className='p-0 font-normal'>
                            <div className='flex items-center gap-2 px-1 py-1.5 text-left text-sm'>
                                <PersonAvatar
                                    name={user.name}
                                    image={user.image}
                                    color={avatarColor}
                                    className='h-8 w-8 rounded-lg'
                                    fallbackClassName='rounded-lg'
                                    decorative
                                />
                                <div className='grid flex-1 text-left text-sm leading-tight'>
                                    <span className='truncate font-medium'>
                                        {user.name}
                                    </span>
                                    <span className='truncate text-xs'>
                                        {user.email}
                                    </span>
                                </div>
                            </div>
                        </DropdownMenuLabel>
                        <DropdownMenuSeparator />
                        <DropdownMenuGroup>
                            <DropdownMenuItem
                                onClick={() => {
                                    router.push(accountPath);
                                }}
                            >
                                <BadgeCheck />
                                {labels.account}
                            </DropdownMenuItem>
                            {notificationPreferencesPath ? (
                                <DropdownMenuItem
                                    onClick={() => {
                                        router.push(
                                            notificationPreferencesPath
                                        );
                                    }}
                                >
                                    <BellRing />
                                    {labels.notificationPreferences ??
                                        'Notification preferences'}
                                </DropdownMenuItem>
                            ) : null}
                            <DropdownMenuItem
                                onClick={() => {
                                    router.push(apiKeysPath);
                                }}
                            >
                                <KeyRound />
                                {labels.apiKeys}
                            </DropdownMenuItem>
                        </DropdownMenuGroup>
                        {languageSwitcher && (
                            <>
                                <DropdownMenuSeparator />
                                <div className='px-2 py-1'>
                                    {languageSwitcher}
                                </div>
                            </>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onClick={() =>
                                authClient.signOut({
                                    fetchOptions: {
                                        onSuccess: () => {
                                            toast.success(labels.loggedOut);
                                            router.push(signOutRedirectPath);
                                        },
                                    },
                                })
                            }
                        >
                            <LogOut />
                            {labels.logOut}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </SidebarMenuItem>
        </SidebarMenu>
    );
}
