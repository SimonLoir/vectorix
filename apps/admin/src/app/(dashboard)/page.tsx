import { DashboardOverview } from '@/components/dashboard-overview';
import { PageHeader } from '@/components/page-header';
import { CreateOrganizationDialog } from '@/components/create-organization-dialog';
import { WorkerObservations } from '@/components/worker-observations';

export default function DashboardPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                titleKey='core.dashboardTitle'
                descriptionKey='core.dashboardDescription'
                action={<CreateOrganizationDialog />}
            />
            <DashboardOverview />
            <WorkerObservations />
        </div>
    );
}
