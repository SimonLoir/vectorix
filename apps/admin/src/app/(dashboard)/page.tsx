import { DashboardOverview } from '@/components/dashboard-overview';
import { PageHeader } from '@/components/page-header';
import { CreateOrganizationDialog } from '@/components/create-organization-dialog';

export default function DashboardPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                title='Tableau de bord'
                description='Pilotez les organisations Vectorix et leur accès aux modules de la plateforme.'
                action={<CreateOrganizationDialog />}
            />
            <DashboardOverview />
        </div>
    );
}
