'use client';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@repo/ui/tabs';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { IndexQueryState } from './index-state';
import { IndexControls } from './index-controls';
import { IndexTasks } from './index-tasks';
import { IndexDocuments } from './index-documents';
import { IndexChunks } from './index-chunks';
import { SearchPlayground } from './search-playground';
import type { Collection } from '../types';

export function CollectionIndexing({
    collection,
}: Readonly<{ collection: Collection }>) {
    const tr = useTranslations('rag.indexing');
    const { orpc } = useORPC();
    const { can, canOperation } = useVectorixPermissions();
    const allowed = canOperation('admin.rag.indexing.status');
    const query = useQuery({
        ...orpc.admin.rag.indexing.status.queryOptions({
            input: { collectionId: collection.id },
        }),
        enabled: allowed,
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 3000),
    });
    if (!allowed)
        return <p className='rounded-lg border p-4'>{tr('readDenied')}</p>;
    const status = query.isError ? undefined : query.data;
    const canInspectDocuments =
        status &&
        (status.canRead || status.canManage) &&
        can({ ragLibrary: ['read'] }) &&
        canOperation('admin.rag.indexing.documents');
    return (
        <section className='space-y-5'>
            <h2 className='text-xl font-semibold'>{tr('title')}</h2>
            <IndexQueryState query={query} />
            {status && (
                <Tabs defaultValue='index' className='space-y-4'>
                    <TabsList className='h-auto max-w-full flex-wrap justify-start'>
                        <TabsTrigger value='index'>
                            {tr('operations')}
                        </TabsTrigger>
                        {canInspectDocuments && (
                            <TabsTrigger value='documents'>
                                {tr('documents')}
                            </TabsTrigger>
                        )}
                        {status.canRead && (
                            <>
                                <TabsTrigger value='chunks'>
                                    {tr('chunks')}
                                </TabsTrigger>
                                <TabsTrigger value='search'>
                                    {tr('playground')}
                                </TabsTrigger>
                            </>
                        )}
                    </TabsList>
                    <TabsContent value='index' className='space-y-5'>
                        <IndexControls
                            key={collection.configurationRevision}
                            collection={collection}
                            status={status}
                        />
                        {canOperation('admin.rag.indexing.tasks') && (
                            <IndexTasks
                                collectionId={collection.id}
                                canManage={status.canManage}
                            />
                        )}
                        {!status.canRead && <p>{tr('readDenied')}</p>}
                    </TabsContent>
                    {canInspectDocuments && (
                        <TabsContent value='documents'>
                            <IndexDocuments
                                collectionId={collection.id}
                                fields={collection.configuration.metadataFields}
                                canManage={status.canManage}
                            />
                        </TabsContent>
                    )}
                    {status.canRead && (
                        <>
                            <TabsContent value='chunks'>
                                <IndexChunks
                                    collectionId={collection.id}
                                    status={status}
                                />
                            </TabsContent>
                            <TabsContent value='search'>
                                <SearchPlayground
                                    key={collection.id}
                                    collectionId={collection.id}
                                    fields={
                                        status.activeConfiguration
                                            ?.metadataFields ?? {}
                                    }
                                    activeGenerationId={
                                        status.active?.id ?? null
                                    }
                                    ready={
                                        Boolean(status.active) &&
                                        canOperation(
                                            'admin.rag.indexing.search'
                                        )
                                    }
                                />
                            </TabsContent>
                        </>
                    )}
                </Tabs>
            )}
        </section>
    );
}
