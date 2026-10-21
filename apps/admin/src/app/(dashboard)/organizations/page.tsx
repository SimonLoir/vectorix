import { OrganizationList } from '@/components/organization-list';
import { PageHeader } from '@/components/page-header';
import { CreateOrganizationDialog } from '@/components/create-organization-dialog';

export default function OrganizationsPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                title='Organisations'
                description='Consultez les comptes inscrits, leur statut, leur plan et leurs fonctionnalités.'
                action={<CreateOrganizationDialog />}
            />
            <OrganizationList />
        </div>
    );
}
