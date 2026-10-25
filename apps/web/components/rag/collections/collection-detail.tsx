'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
    ArrowLeft,
    Database,
    History,
    LockKeyhole,
    Settings2,
    Workflow,
} from 'lucide-react';
import { Button } from '@repo/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@repo/ui/tabs';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogQueryState } from '../catalog-controls';
import { ConfirmCatalogAction } from '../catalog-dialog';
import { CollectionIndexing } from '../indexing/collection-indexing';
import { CollectionOverview } from './collection-overview';
import { CollectionForm } from './collection-form';
import { RevisionHistory } from './revision-history';
import { CollectionGrants } from './collection-grants';
import type { Collection } from '../types';

export function CollectionDetail({ id }: Readonly<{ id: string }>) {
    const tr = useTranslations('rag');
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const router = useRouter();
    const [editing, setEditing] = useState<Collection | null>(null);
    const [deleting, setDeleting] = useState<Collection | null>(null);
    const [selectedTab, setSelectedTab] = useState('overview');
    const query = useQuery(
        orpc.admin.rag.collections.get.queryOptions({
            input: { id },
            retry: false,
            staleTime: 0,
        })
    );
    const statusAllowed = canOperation('admin.rag.indexing.status');
    const statusQuery = useQuery({
        ...orpc.admin.rag.indexing.status.queryOptions({
            input: { collectionId: id },
        }),
        enabled: Boolean(query.data) && statusAllowed,
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 3000),
    });
    const indexStatus = statusQuery.data;
    const profileLocked =
        statusAllowed &&
        (!indexStatus ||
            statusQuery.isError ||
            indexStatus.generations.some(
                (generation) =>
                    generation.id !== indexStatus.active?.id &&
                    ['PROVISIONING', 'BUILDING', 'FAILED'].includes(
                        generation.status
                    )
            ));
    if (query.isPending || query.isError)
        return <CatalogQueryState query={query} />;
    const item = query.data;
    const canManageAccess =
        item.permissions.administer &&
        canOperation('admin.rag.collections.grants');
    const activeTab =
        selectedTab === 'access' && !canManageAccess ? 'overview' : selectedTab;
    return (
        <div className='space-y-5'>
            <Link
                href='/dashboard/collections'
                className='inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-primary'
            >
                <ArrowLeft className='size-4' aria-hidden />
                {tr('collections.back')}
            </Link>
            <section className='vectorix-collection-heading space-y-4 rounded-xl border bg-card p-5 sm:p-6'>
                <div className='flex flex-wrap items-start justify-between gap-4'>
                    <div className='flex min-w-0 flex-1 items-start gap-3'>
                        <span className='vectorix-icon-tile mt-1 inline-flex size-10 shrink-0 items-center justify-center rounded-xl'>
                            <Database className='size-5' aria-hidden />
                        </span>
                        <div className='min-w-0'>
                            <h2 className='break-words text-2xl font-semibold'>
                                {item.name}
                            </h2>
                            <p className='mt-2 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground'>
                                {item.description ||
                                    tr('collections.noDescription')}
                            </p>
                        </div>
                    </div>
                    <div className='flex flex-wrap gap-2'>
                        {item.permissions.administer &&
                            canOperation('admin.rag.collections.update') && (
                                <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() => setEditing(item)}
                                >
                                    <Settings2 className='size-4' aria-hidden />
                                    {tr('collections.editProfile')}
                                </Button>
                            )}
                        {item.permissions.administer &&
                            canOperation('admin.rag.collections.delete') && (
                                <Button
                                    variant='ghost'
                                    size='sm'
                                    className='text-danger hover:text-danger'
                                    onClick={() => setDeleting(item)}
                                >
                                    {tr('collections.delete')}
                                </Button>
                            )}
                    </div>
                </div>
                <p className='border-t pt-3 text-xs text-muted-foreground'>
                    {tr('collections.accessSummary', {
                        read: item.permissions.read ? 'allowed' : 'denied',
                        documents: item.permissions.manageDocuments
                            ? 'allowed'
                            : 'denied',
                    })}
                </p>
            </section>
            <Tabs
                value={activeTab}
                onValueChange={setSelectedTab}
                className='gap-5'
            >
                <TabsList className='h-auto w-full flex-wrap justify-start gap-1 rounded-xl border bg-card p-1 sm:w-fit'>
                    <TabsTrigger
                        value='overview'
                        className='flex-none px-3 py-2'
                    >
                        <Database className='size-4' aria-hidden />
                        {tr('collections.overviewTab')}
                    </TabsTrigger>
                    <TabsTrigger
                        value='workspace'
                        className='flex-none px-3 py-2'
                    >
                        <Workflow className='size-4' aria-hidden />
                        {tr('collections.workspaceTab')}
                    </TabsTrigger>
                    {canManageAccess && (
                        <TabsTrigger
                            value='access'
                            className='flex-none px-3 py-2'
                        >
                            <LockKeyhole className='size-4' aria-hidden />
                            {tr('collections.accessTab')}
                        </TabsTrigger>
                    )}
                    <TabsTrigger
                        value='history'
                        className='flex-none px-3 py-2'
                    >
                        <History className='size-4' aria-hidden />
                        {tr('collections.historyTab')}
                    </TabsTrigger>
                </TabsList>
                <TabsContent
                    value='overview'
                    forceMount
                    hidden={activeTab !== 'overview'}
                >
                    <CollectionOverview collection={item} />
                </TabsContent>
                <TabsContent
                    value='workspace'
                    forceMount
                    hidden={activeTab !== 'workspace'}
                >
                    <CollectionIndexing collection={item} />
                </TabsContent>
                {canManageAccess && (
                    <TabsContent
                        value='access'
                        forceMount
                        hidden={activeTab !== 'access'}
                    >
                        <CollectionGrants id={id} />
                    </TabsContent>
                )}
                <TabsContent
                    value='history'
                    forceMount
                    hidden={activeTab !== 'history'}
                >
                    <RevisionHistory id={id} />
                </TabsContent>
            </Tabs>
            {editing && (
                <CollectionForm
                    existing={editing}
                    profileLocked={profileLocked}
                    onClose={() => setEditing(null)}
                />
            )}
            {deleting && (
                <ConfirmCatalogAction
                    title={tr('collections.deleteTitle')}
                    description={tr('collections.deleteDescription', {
                        name: deleting.name,
                    })}
                    onClose={() => setDeleting(null)}
                    action={async () => {
                        await client.admin.rag.collections.delete({
                            id,
                            expectedRevision: deleting.configurationRevision,
                        });
                        router.replace('/dashboard/collections');
                    }}
                />
            )}
        </div>
    );
}
