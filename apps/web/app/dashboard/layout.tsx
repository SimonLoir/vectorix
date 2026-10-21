import { AppPageProvider } from '@repo/dashboard-core/components/app-page-context';
import {
    SidebarInset,
    SidebarProvider,
    SidebarTrigger,
} from '@repo/ui/sidebar';
import { isOrganizationCreationAllowed } from '@repo/auth/organization-creation';
import { AppSidebar } from '@/components/app-sidebar';
import { VectorixPermissionsProvider } from '@/contexts/vectorix-permissions';
import { NotificationProvider } from '@/components/notifications/notification-provider';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { DashboardQueryScope } from '@/components/dashboard-query-scope';
import { PwaRegistration } from '@/components/pwa-registration';
export default function DashboardLayout({
    children,
}: Readonly<{ children: React.ReactNode }>) {
    return (
        <DashboardQueryScope>
            <VectorixPermissionsProvider>
                <AppPageProvider>
                    <NotificationProvider>
                        <PwaRegistration />
                        <SidebarProvider>
                            <AppSidebar
                                allowOrganizationCreation={isOrganizationCreationAllowed()}
                            />
                            <SidebarInset className='min-w-0 bg-muted/20'>
                                <header className='flex h-16 items-center justify-between border-b px-6'>
                                    <SidebarTrigger />
                                    <NotificationBell />
                                </header>
                                {children}
                            </SidebarInset>
                        </SidebarProvider>
                    </NotificationProvider>
                </AppPageProvider>
            </VectorixPermissionsProvider>
        </DashboardQueryScope>
    );
}
