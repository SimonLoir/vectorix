'use client';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogQueryState } from '../catalog-controls';
import { ConfirmCatalogAction } from '../catalog-dialog';
import { CollectionIndexing } from '../indexing/collection-indexing';
import { ProfileSummary } from './profile-summary';
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
    const query = useQuery(
        orpc.admin.rag.collections.get.queryOptions({
            input: { id },
            retry: false,
            staleTime: 0,
        })
    );
    if (query.isPending || query.isError)
        return <CatalogQueryState query={query} />;
    const item = query.data;
    return (
        <div className='space-y-6'>
            <Link
                href='/dashboard/collections'
                className='text-sm underline underline-offset-4'
            >
                {tr('collections.back')}
            </Link>
            <section className='rounded-xl border bg-card p-6 space-y-5'>
                <div className='flex flex-wrap justify-between gap-4'>
                    <div>
                        <h2 className='text-2xl font-semibold break-words'>
                            {item.name}
                        </h2>
                        <p className='mt-2 whitespace-pre-wrap text-muted-foreground'>
                            {item.description}
                        </p>
                    </div>
                </div>

                <ProfileSummary configuration={item.configuration} />
                <div className='flex flex-wrap gap-2'>
                    {item.permissions.administer &&
                        canOperation('admin.rag.collections.update') && (
                            <Button
                                variant='outline'
                                onClick={() => setEditing(item)}
                            >
                                {tr('collections.editProfile')}
                            </Button>
                        )}
                    {item.permissions.administer &&
                        canOperation('admin.rag.collections.delete') && (
                            <Button
                                variant='outline'
                                onClick={() => setDeleting(item)}
                            >
                                {tr('collections.delete')}
                            </Button>
                        )}
                </div>
                <p className='text-xs text-muted-foreground'>
                    {tr('collections.accessSummary', {
                        read: item.permissions.read ? 'allowed' : 'denied',
                        documents: item.permissions.manageDocuments
                            ? 'allowed'
                            : 'denied',
                    })}
                </p>
            </section>
            {item.permissions.administer &&
                canOperation('admin.rag.collections.grants') && (
                    <CollectionGrants id={id} />
                )}
            <CollectionIndexing collection={item} />
            <RevisionHistory id={id} />
            {editing && (
                <CollectionForm
                    existing={editing}
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
