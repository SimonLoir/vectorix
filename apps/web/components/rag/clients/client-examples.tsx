'use client';
import { useTranslations } from 'next-intl';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { ClientCode } from './client-code';
import { mcpTemplate, sdkTemplate } from './client-templates';

/** These are local installation examples, not publication or a remote MCP service. */
export function ClientExamples({
    apiUrl,
    organizationId,
    collectionId,
    ready,
}: Readonly<{
    apiUrl: string;
    organizationId: string;
    collectionId: string;
    ready: boolean;
}>) {
    const tr = useTranslations('rag.clients');
    const connection = { apiUrl, organizationId, collectionId };
    return (
        <section className='min-w-0 space-y-4 rounded-xl border bg-card p-4 sm:p-5'>
            <p className='text-sm text-muted-foreground'>
                {tr('localPackages')}
            </p>
            <Tabs defaultValue='sdk' className='min-w-0 gap-4'>
                <TabsList aria-label={tr('examples')} className='max-w-full'>
                    <TabsTrigger value='sdk'>{tr('sdk')}</TabsTrigger>
                    <TabsTrigger value='mcp'>{tr('mcp')}</TabsTrigger>
                </TabsList>
                <TabsContent value='sdk' className='min-w-0 space-y-3'>
                    <p className='text-sm'>{tr('sdkHint')}</p>
                    <ClientCode
                        title={tr('sdk')}
                        code={sdkTemplate(connection, tr('exampleQuestion'))}
                        disabled={!ready}
                    />
                </TabsContent>
                <TabsContent value='mcp' className='min-w-0 space-y-3'>
                    <p className='text-sm'>{tr('mcpHint')}</p>
                    <p className='text-xs text-muted-foreground'>
                        {tr('allowlistHint')}
                    </p>
                    <ClientCode
                        title={tr('mcp')}
                        code={mcpTemplate(connection)}
                        disabled={!ready}
                    />
                </TabsContent>
            </Tabs>
            {!ready && (
                <p role='status' className='text-sm text-muted-foreground'>
                    {tr('chooseHint')}
                </p>
            )}
        </section>
    );
}
