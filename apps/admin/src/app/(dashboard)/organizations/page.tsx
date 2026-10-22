import { OrganizationList } from '@/components/organization-list';
import { PageHeader } from '@/components/page-header';
import { CreateOrganizationDialog } from '@/components/create-organization-dialog';

export default function OrganizationsPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                titleKey='core.organizations'
                descriptionKey='core.organizationsDescription'
                action={<CreateOrganizationDialog />}
            />
            <OrganizationList />
        </div>
    );
}
