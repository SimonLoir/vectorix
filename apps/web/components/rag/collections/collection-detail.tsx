'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { Badge } from '@repo/ui/badge';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogQueryState } from '../catalog-controls';
import { ConfirmCatalogAction } from '../catalog-dialog';
import { ProfileSummary } from './profile-summary';
import { CollectionForm } from './collection-form';
import { RevisionHistory } from './revision-history';
import { CollectionGrants } from './collection-grants';
import type { Collection } from '../types';

export function CollectionDetail({ id }: Readonly<{ id: string }>) {
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
                ← Toutes les collections
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
                    <Badge variant='secondary'>Configuration uniquement</Badge>
                </div>
                <p className='rounded-lg bg-muted p-4 text-sm'>
                    Ce profil est enregistré. L’ajout de documents, l’indexation
                    et le playground de recherche ne sont pas encore
                    disponibles.
                </p>
                <ProfileSummary configuration={item.configuration} />
                <div className='flex flex-wrap gap-2'>
                    {item.permissions.administer &&
                        canOperation('admin.rag.collections.update') && (
                            <Button
                                variant='outline'
                                onClick={() => setEditing(item)}
                            >
                                Modifier le profil
                            </Button>
                        )}
                    {item.permissions.administer &&
                        canOperation('admin.rag.collections.delete') && (
                            <Button
                                variant='outline'
                                onClick={() => setDeleting(item)}
                            >
                                Supprimer la collection
                            </Button>
                        )}
                </div>
                <p className='text-xs text-muted-foreground'>
                    Votre accès explicite : lecture{' '}
                    {item.permissions.read ? 'autorisée' : 'non accordée'} ·
                    gestion des documents{' '}
                    {item.permissions.manageDocuments
                        ? 'autorisée'
                        : 'non accordée'}
                    . Administrer le catalogue ne donne pas automatiquement
                    accès au contenu.
                </p>
            </section>
            {item.permissions.administer &&
                canOperation('admin.rag.collections.grants') && (
                    <CollectionGrants id={id} />
                )}
            <RevisionHistory id={id} />
            {editing && (
                <CollectionForm
                    existing={editing}
                    onClose={() => setEditing(null)}
                />
            )}
            {deleting && (
                <ConfirmCatalogAction
                    title='Supprimer cette collection ?'
                    description={`${deleting.name} ne sera plus accessible. Les documents de la bibliothèque restent conservés.`}
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
