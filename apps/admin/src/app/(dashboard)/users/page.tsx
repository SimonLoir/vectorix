import { PageHeader } from '@/components/page-header';
import { UserList } from '@/components/user-list';

export default function UsersPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                titleKey='secondary.pages.usersTitle'
                descriptionKey='secondary.pages.usersDescription'
            />
            <UserList />
        </div>
    );
}
