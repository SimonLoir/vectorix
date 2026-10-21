'use client';
import Link from 'next/link';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { OrganizationSummary } from './organization-summary';
import { OrganizationMembers } from './organization-members';
import { OrganizationFeatures } from './organization-features';
export function OrganizationWorkspace({
    organizationId,
}: {
    readonly organizationId: string;
}) {
    return (
        <div className='space-y-6'>
            <Link href='/organizations' className='text-sm text-slate-400'>
                ← Organisations
            </Link>
            <Tabs defaultValue='summary'>
                <TabsList>
                    <TabsTrigger value='summary'>Organisation</TabsTrigger>
                    <TabsTrigger value='members'>Membres</TabsTrigger>
                    <TabsTrigger value='features'>
                        Licences et fonctionnalités
                    </TabsTrigger>
                </TabsList>
                <TabsContent value='summary'>
                    <OrganizationSummary organizationId={organizationId} />
                </TabsContent>
                <TabsContent value='members'>
                    <OrganizationMembers organizationId={organizationId} />
                </TabsContent>
                <TabsContent value='features'>
                    <OrganizationFeatures organizationId={organizationId} />
                </TabsContent>
            </Tabs>
        </div>
    );
}
