import { AuditLogList } from '@/components/audit-log-list';
import { PageHeader } from '@/components/page-header';

export default function AuditPage() {
    return (
        <div className='space-y-8'>
            <PageHeader
                titleKey='secondary.pages.auditTitle'
                descriptionKey='secondary.pages.auditDescription'
            />
            <AuditLogList />
        </div>
    );
}
