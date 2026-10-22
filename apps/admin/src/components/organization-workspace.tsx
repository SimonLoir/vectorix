'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { OrganizationSemanticQuota } from './organization-semantic-quota';
import { OrganizationRagQuota } from './organization-rag-quota';
import { OrganizationSummary } from './organization-summary';
import { OrganizationMembers } from './organization-members';
import { OrganizationFeatures } from './organization-features';
import { OrganizationOperations } from './organization-operations';
import { OrganizationTelemetry } from './organization-telemetry';
export function OrganizationWorkspace({
    organizationId,
}: {
    readonly organizationId: string;
}) {
    const tr = useTranslations('admin');
    return (
        <div className='space-y-6'>
            <Link href='/organizations' className='text-sm text-slate-400'>
                {tr('workspace.back')}
            </Link>
            <Tabs defaultValue='summary'>
                <TabsList className='h-auto max-w-full flex-wrap justify-start'>
                    <TabsTrigger value='summary'>
                        {tr('workspace.organization')}
                    </TabsTrigger>
                    <TabsTrigger value='rag'>{tr('workspace.rag')}</TabsTrigger>
                    <TabsTrigger value='operations'>
                        {tr('workspace.operations')}
                    </TabsTrigger>
                    <TabsTrigger value='telemetry'>
                        {tr('workspace.telemetry')}
                    </TabsTrigger>
                    <TabsTrigger value='members'>
                        {tr('workspace.members')}
                    </TabsTrigger>
                    <TabsTrigger value='features'>
                        {tr('workspace.features')}
                    </TabsTrigger>
                </TabsList>
                <TabsContent value='summary'>
                    <OrganizationSummary organizationId={organizationId} />
                </TabsContent>
                <TabsContent value='rag' className='space-y-6'>
                    <OrganizationRagQuota organizationId={organizationId} />
                    <OrganizationSemanticQuota
                        organizationId={organizationId}
                    />
                </TabsContent>
                <TabsContent value='members'>
                    <OrganizationMembers organizationId={organizationId} />
                </TabsContent>
                <TabsContent value='operations'>
                    <OrganizationOperations organizationId={organizationId} />
                </TabsContent>
                <TabsContent value='telemetry'>
                    <OrganizationTelemetry organizationId={organizationId} />
                </TabsContent>
                <TabsContent value='features'>
                    <OrganizationFeatures organizationId={organizationId} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
