import { AppPageProvider } from '@repo/dashboard-core/components/app-page-context';
import { SidebarInset, SidebarProvider } from '@repo/ui/sidebar';
import { isOrganizationCreationAllowed } from '@repo/auth/organization-creation';
import { AppSidebar } from '@/components/app-sidebar';
import { VectorixPermissionsProvider } from '@/contexts/vectorix-permissions';
import { NotificationProvider } from '@/components/notifications/notification-provider';
import { DashboardQueryScope } from '@/components/dashboard-query-scope';
import { PwaRegistration } from '@/components/pwa-registration';
import { AppHeader } from '@/components/shell/app-header';
import { CommandPaletteProvider } from '@/components/shell/command-palette';
export default function DashboardLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    return (
        <DashboardQueryScope>
            <VectorixPermissionsProvider>
                <AppPageProvider>
                    <NotificationProvider>
                        <PwaRegistration />
                        <CommandPaletteProvider>
                            <SidebarProvider data-vectorix-dashboard>
                                <AppSidebar
                                    allowOrganizationCreation={isOrganizationCreationAllowed()}
                                />
                                <SidebarInset className='min-w-0'>
                                    <AppHeader />
                                    {children}
                                </SidebarInset>
                            </SidebarProvider>
                        </CommandPaletteProvider>
                    </NotificationProvider>
                </AppPageProvider>
            </VectorixPermissionsProvider>
        </DashboardQueryScope>
    );
}
