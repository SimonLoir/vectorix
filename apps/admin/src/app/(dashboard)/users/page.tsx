import { PageHeader } from '@/components/page-header';
import { UserList } from '@/components/user-list';

export default function UsersPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                title='Utilisateurs'
                description='Consultez les comptes Vectorix, leurs organisations et leur accès à la console superadmin.'
            />
            <UserList />
        </div>
    );
}
