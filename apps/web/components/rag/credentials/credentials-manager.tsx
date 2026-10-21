'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { Badge } from '@repo/ui/badge';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import {
    CatalogSearch,
    CatalogPagination,
    CatalogQueryState,
    useCatalogPagination,
} from '../catalog-controls';
import { ConfirmCatalogAction } from '../catalog-dialog';
import { CredentialForm } from './credential-form';
import type { Credential } from '../types';

export function CredentialsManager() {
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const page = useCatalogPagination();
    const query = useQuery(
        orpc.admin.rag.credentials.list.queryOptions({
            input: {
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        })
    );
    const [editing, setEditing] = useState<Credential | 'new' | null>(null);
    const [confirm, setConfirm] = useState<{
        item: Credential;
        activate: boolean;
    } | null>(null);
    return (
        <div className='space-y-5'>
            <div className='rounded-xl border bg-muted/30 p-4 text-sm space-y-2'>
                <p>
                    La configuration de l’organisation est prioritaire. En son
                    absence, les valeurs de la plateforme sont utilisées si
                    elles sont disponibles.
                </p>
                <p>
                    Une configuration invalide ne déclenche aucun repli. Les
                    collections existantes conservent leur liaison enregistrée,
                    même si vous activez d’autres credentials.
                </p>
                <p className='text-muted-foreground'>
                    Configuration uniquement · Les connexions et modèles ne sont
                    pas encore vérifiés en direct.
                </p>
            </div>
            <div className='flex flex-wrap justify-between gap-3'>
                <CatalogSearch
                    value={page.query}
                    onChange={page.search}
                    label='Rechercher des credentials'
                />
                {canOperation('admin.rag.credentials.create') && (
                    <Button onClick={() => setEditing('new')}>
                        Ajouter des credentials
                    </Button>
                )}
            </div>
            <CatalogQueryState query={query} />
            {!query.isError && query.data && (
                <>
                    <div className='grid gap-4 lg:grid-cols-2'>
                        {query.data.items.map((item) => (
                            <article
                                className='rounded-xl border bg-card p-5 space-y-4'
                                key={item.id}
                            >
                                <div className='flex items-start justify-between gap-3'>
                                    <div>
                                        <h2 className='font-semibold break-words'>
                                            {item.name}
                                        </h2>
                                        <p className='text-sm text-muted-foreground'>
                                            {item.provider} · Révision{' '}
                                            {item.revision}
                                        </p>
                                    </div>
                                    <Badge
                                        variant={
                                            item.active
                                                ? 'default'
                                                : 'secondary'
                                        }
                                    >
                                        {item.active
                                            ? 'Sélectionné'
                                            : 'Non sélectionné'}
                                    </Badge>
                                </div>
                                <p className='break-all text-sm'>
                                    {item.data.endpoint}
                                </p>
                                {item.data.provider === 'S3' && (
                                    <p className='text-sm'>
                                        Bucket : {item.data.bucket} ·{' '}
                                        {item.data.region}
                                    </p>
                                )}
                                <p className='text-xs text-muted-foreground'>
                                    Secrets masqués · Connexion non vérifiée
                                </p>
                                <div className='flex flex-wrap gap-2'>
                                    {canOperation(
                                        'admin.rag.credentials.update'
                                    ) && (
                                        <Button
                                            variant='outline'
                                            onClick={() => setEditing(item)}
                                        >
                                            Modifier / renouveler
                                        </Button>
                                    )}
                                    {!item.active &&
                                        canOperation(
                                            'admin.rag.credentials.activate'
                                        ) && (
                                            <Button
                                                variant='outline'
                                                onClick={() =>
                                                    setConfirm({
                                                        item,
                                                        activate: true,
                                                    })
                                                }
                                            >
                                                Sélectionner
                                            </Button>
                                        )}
                                    {canOperation(
                                        'admin.rag.credentials.delete'
                                    ) && (
                                        <Button
                                            variant='ghost'
                                            onClick={() =>
                                                setConfirm({
                                                    item,
                                                    activate: false,
                                                })
                                            }
                                        >
                                            Supprimer
                                        </Button>
                                    )}
                                </div>
                            </article>
                        ))}
                    </div>
                    {query.data.total === 0 && (
                        <p className='rounded-xl border border-dashed p-8 text-center text-muted-foreground'>
                            Aucun credential à afficher.
                        </p>
                    )}
                    <CatalogPagination
                        offset={page.offset}
                        total={query.data.total}
                        onChange={page.setOffset}
                    />
                </>
            )}
            {editing && (
                <CredentialForm
                    existing={editing === 'new' ? undefined : editing}
                    onClose={() => setEditing(null)}
                />
            )}
            {confirm && (
                <ConfirmCatalogAction
                    title={
                        confirm.activate
                            ? 'Sélectionner ces credentials ?'
                            : 'Supprimer ces credentials ?'
                    }
                    description={
                        confirm.activate
                            ? `${confirm.item.name} sera utilisé pour les nouvelles configurations de ce fournisseur. Les collections existantes restent inchangées.`
                            : `${confirm.item.name} sera supprimé si aucune collection ou destination de stockage ne le référence.`
                    }
                    onClose={() => setConfirm(null)}
                    action={() =>
                        confirm.activate
                            ? client.admin.rag.credentials.activate({
                                  id: confirm.item.id,
                              })
                            : client.admin.rag.credentials.delete({
                                  id: confirm.item.id,
                                  expectedRevision: confirm.item.revision,
                              })
                    }
                />
            )}
        </div>
    );
}
