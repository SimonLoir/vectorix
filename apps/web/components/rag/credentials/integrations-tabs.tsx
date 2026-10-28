'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/tabs';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CredentialsManager } from './credentials-manager';
import { RerankEndpointsManager } from '../reranking/endpoints-manager';
import { ClientIntegrations } from '../clients/client-integrations';

/** Keep permitted drafts mounted; readers can use client templates without mounting credential queries. */
export function IntegrationsTabs() {
    const tr = useTranslations('rag.reranking.endpoints');
    const clientsTr = useTranslations('rag.clients');
    const { canOperation } = useVectorixPermissions();
    const canCredentials = canOperation('admin.rag.credentials.list');
    const [selectedTab, setSelectedTab] = useState('providers');
    const tab = canCredentials ? selectedTab : 'clients';
    return (
        <Tabs value={tab} onValueChange={setSelectedTab} className='gap-5'>
            <TabsList
                aria-label={tr('views')}
                className='h-auto w-full flex-wrap justify-start sm:w-fit'
            >
                {canCredentials && (
                    <>
                        <TabsTrigger value='providers'>
                            {tr('providersTab')}
                        </TabsTrigger>
                        <TabsTrigger value='reranking'>{tr('tab')}</TabsTrigger>
                    </>
                )}
                <TabsTrigger value='clients'>{clientsTr('tab')}</TabsTrigger>
            </TabsList>
            {canCredentials && (
                <>
                    <TabsContent
                        value='providers'
                        forceMount
                        hidden={tab !== 'providers'}
                    >
                        <CredentialsManager />
                    </TabsContent>
                    <TabsContent
                        value='reranking'
                        forceMount
                        hidden={tab !== 'reranking'}
                    >
                        <RerankEndpointsManager active={tab === 'reranking'} />
                    </TabsContent>
                </>
            )}
            <TabsContent value='clients' forceMount hidden={tab !== 'clients'}>
                <ClientIntegrations active={tab === 'clients'} />
            </TabsContent>
        </Tabs>
    );
}
