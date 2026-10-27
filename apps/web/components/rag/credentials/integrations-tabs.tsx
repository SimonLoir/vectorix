'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/tabs';
import { CredentialsManager } from './credentials-manager';
import { RerankEndpointsManager } from '../reranking/endpoints-manager';

/** Keep both bounded views' drafts while deferring endpoint reads until their tab is opened. */
export function IntegrationsTabs() {
    const tr = useTranslations('rag.reranking.endpoints');
    const [tab, setTab] = useState('providers');
    return (
        <Tabs value={tab} onValueChange={setTab} className='gap-5'>
            <TabsList
                aria-label={tr('views')}
                className='h-auto w-full flex-wrap justify-start sm:w-fit'
            >
                <TabsTrigger value='providers'>
                    {tr('providersTab')}
                </TabsTrigger>
                <TabsTrigger value='reranking'>{tr('tab')}</TabsTrigger>
            </TabsList>
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
        </Tabs>
    );
}
