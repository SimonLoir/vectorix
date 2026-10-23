'use client';

import * as React from 'react';
import { ChevronsUpDown, Plus } from 'lucide-react';
import Link from 'next/link';

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
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
    OrganizationAvatar,
    OrganizationRecovery,
} from './organization-selection-state';

export function TeamSwitcher({
    allowOrganizationCreation = false,
    showEmptyOrganizationOnboarding = true,
}: Readonly<{
    allowOrganizationCreation?: boolean;
    /** Account and invitation recovery may remain accessible before membership. */
    showEmptyOrganizationOnboarding?: boolean;
}>) {
    const authClient = useAuth();
    const {
        data: organizations,
        isPending: organizationsPending,
        error: organizationsError,
        refetch,
    } = authClient.useListOrganizations();
    const { isMobile } = useSidebar();
    const {
        data: activeOrganization,
        isPending: activeOrganizationPending,
        error: activeOrganizationError,
    } = authClient.useActiveOrganization();
    const [showNewOrgModal, setShowNewOrgModal] = React.useState(false);
    const [switching, setSwitching] = React.useState(false);
    const switchingRef = React.useRef(false);
    const t = useTranslations('teamSwitcher');
    const loading = organizationsPending || activeOrganizationPending;
    const loadFailed = Boolean(organizationsError ?? activeOrganizationError);
    const informationReady = !loading && !loadFailed;
    const noActiveOrganization = informationReady && !activeOrganization;
    const emptyOrganizationList =
        informationReady && organizations?.length === 0;

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

    if (emptyOrganizationList && !showEmptyOrganizationOnboarding) return null;

    if (emptyOrganizationList)
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

    let organizationLabel =
        activeOrganization?.name ?? t('noActiveOrganization');
    if (loadFailed) organizationLabel = t('loadFailed');
    if (loading) organizationLabel = t('loading');

    return (
        <>
            <SidebarMenu>
                <SidebarMenuItem>
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <SidebarMenuButton
                                size='lg'
                                disabled={switching || loading}
                                aria-label={t('selectorLabel', {
                                    organization: organizationLabel,
                                })}
                                aria-busy={loading || switching}
                                className='data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground'
                            >
                                <OrganizationAvatar
                                    name={
                                        loadFailed
                                            ? null
                                            : (activeOrganization?.name ?? null)
                                    }
                                    logo={
                                        loadFailed
                                            ? null
                                            : (activeOrganization?.logo ?? null)
                                    }
                                    loading={loading}
                                />
                                <div className='grid flex-1 text-left text-sm leading-tight'>
                                    <span className='truncate font-medium'>
                                        {organizationLabel}
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
                                        loadFailed ||
                                        organization.id ===
                                            activeOrganization?.id
                                    }
                                    onClick={() =>
                                        void switchOrganization(organization.id)
                                    }
                                    className='gap-2 p-2'
                                >
                                    <div className='flex size-6 items-center justify-center rounded-md border'></div>
                                    <span className='min-w-0 flex-1 truncate'>
                                        {organization.name}
                                    </span>
                                    <DropdownMenuShortcut>
                                        ⌘{index + 1}
                                    </DropdownMenuShortcut>
                                </DropdownMenuItem>
                            ))}
                            <DropdownMenuSeparator />
                            {loadFailed && (
                                <DropdownMenuItem
                                    onSelect={() =>
                                        globalThis.location.reload()
                                    }
                                >
                                    {t('reload')}
                                </DropdownMenuItem>
                            )}
                            {(noActiveOrganization || loadFailed) && (
                                <DropdownMenuItem asChild>
                                    <Link href='/dashboard/account'>
                                        {t('openAccount')}
                                    </Link>
                                </DropdownMenuItem>
                            )}
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
                    {!loading && (noActiveOrganization || loadFailed) && (
                        <OrganizationRecovery
                            loadFailed={loadFailed}
                            switching={switching}
                        />
                    )}
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
