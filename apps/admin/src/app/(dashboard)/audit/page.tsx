import { AuditLogList } from '@/components/audit-log-list';
import { PageHeader } from '@/components/page-header';

export default function AuditPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                title='Journal d’audit'
                description='Retrouvez toutes les actions sensibles effectuées depuis le superadmin.'
            />
            <AuditLogList />
        </div>
    );
}
