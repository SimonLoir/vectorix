'use client';

import * as React from 'react';
import { ChevronsUpDown, Plus } from 'lucide-react';

import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@repo/ui/dropdown-menu';
import {
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    useSidebar,
} from '@repo/ui/sidebar';
import { useAuth } from '../../hooks/use-auth';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@repo/ui/dialog';
import NewOrganizationForm from './new-organization-form';
import { Avatar, AvatarFallback, AvatarImage } from '@repo/ui/avatar';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

export function TeamSwitcher({
    allowOrganizationCreation = false,
}: Readonly<{
    allowOrganizationCreation?: boolean;
}>) {
    const authClient = useAuth();
    const { data: organizations, refetch } = authClient.useListOrganizations();
    const { isMobile } = useSidebar();
    const { data: activeOrganization } = authClient.useActiveOrganization();
    const [showNewOrgModal, setShowNewOrgModal] = React.useState(false);
    const [switching, setSwitching] = React.useState(false);
    const switchingRef = React.useRef(false);
    const t = useTranslations('teamSwitcher');

    async function switchOrganization(organizationId: string) {
        if (switchingRef.current || organizationId === activeOrganization?.id)
            return;
        switchingRef.current = true;
        setSwitching(true);
        try {
            const result = await authClient.organization.setActive({
                organizationId,
            });
            if (result.error || result.data?.id !== organizationId)
                throw new Error('Organization switch failed');
            // Avoid refetching old-tenant queries between setActive and auth atom updates.
            globalThis.location.assign('/dashboard');
        } catch {
            switchingRef.current = false;
            setSwitching(false);
            toast.error(t('switchFailed'));
        }
    }

    if (organizations?.length === 0)
        return (
            <Dialog open={true} onOpenChange={() => {}}>
                <DialogContent showCloseButton={false}>
                    <DialogHeader>
                        <DialogTitle>{t('welcomeTitle')}</DialogTitle>
                        <DialogDescription>
                            {t(
                                allowOrganizationCreation
                                    ? 'noOrgDescription'
                                    : 'noOrgCreationDescription'
                            )}
                        </DialogDescription>
                        <NewOrganizationForm
                            allowOrganizationCreation={
                                allowOrganizationCreation
                            }
                        />
                    </DialogHeader>
                </DialogContent>
            </Dialog>
        );

    const activeOrganizationFallback =
        activeOrganization?.name
            .split(' ')
            .map((part) => part[0]?.toUpperCase() ?? '')
            .join('') ?? '';

    return (
        <>
            <SidebarMenu>
                <SidebarMenuItem>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <SidebarMenuButton
                                size='lg'
                                disabled={switching}
                                className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
                            >
                                <Avatar className='size-8 rounded-lg'>
                                    <AvatarImage
                                        src={activeOrganization?.logo ?? ''}
                                        alt={activeOrganization?.name}
                                    />
                                    <AvatarFallback className='rounded-lg'>
                                        {activeOrganizationFallback}
                                    </AvatarFallback>
                                </Avatar>
                                <div className='grid flex-1 text-left text-sm leading-tight'>
                                    <span className='truncate font-medium'>
                                        {activeOrganization?.name}
                                    </span>
                                </div>
                                <ChevronsUpDown className='ml-auto' />
                            </SidebarMenuButton>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                            className='w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg'
                            align='start'
                            side={isMobile ? 'bottom' : 'right'}
                            sideOffset={4}
                        >
                            <DropdownMenuLabel className='text-muted-foreground text-xs'>
                                {t('organizations')}
                            </DropdownMenuLabel>
                            {organizations?.map((organization, index) => (
                                <DropdownMenuItem
                                    key={organization.id}
                                    disabled={
                                        switching ||
                                        organization.id ===
                                            activeOrganization?.id
                                    }
                                    onClick={() =>
                                        void switchOrganization(organization.id)
                                    }
                                    className='gap-2 p-2'
                                >
                                    <div className='flex size-6 items-center justify-center rounded-md border'></div>
                                    {organization.name}
                                    <DropdownMenuShortcut>
                                        ⌘{index + 1}
                                    </DropdownMenuShortcut>
                                </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                                className='gap-2 p-2'
                                onClick={() => setShowNewOrgModal(true)}
                            >
                                <div className='flex size-6 items-center justify-center rounded-md border bg-transparent'>
                                    <Plus className='size-4' />
                                </div>
                                <div className='text-muted-foreground font-medium'>
                                    {t(
                                        allowOrganizationCreation
                                            ? 'addOrganization'
                                            : 'joinOrganization'
                                    )}
                                </div>
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                </SidebarMenuItem>
            </SidebarMenu>
            <Dialog open={showNewOrgModal} onOpenChange={setShowNewOrgModal}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>
                            {t(
                                allowOrganizationCreation
                                    ? 'createOrganizationTitle'
                                    : 'joinOrganizationTitle'
                            )}
                        </DialogTitle>
                        <DialogDescription>
                            {t(
                                allowOrganizationCreation
                                    ? 'createOrganizationDescription'
                                    : 'joinOrganizationDescription'
                            )}
                        </DialogDescription>
                        <NewOrganizationForm
                            allowOrganizationCreation={
                                allowOrganizationCreation
                            }
                            onCreate={() => {
                                setShowNewOrgModal(false);
                                void refetch();
                            }}
                        />
                    </DialogHeader>
                </DialogContent>
            </Dialog>
        </>
    );
}
