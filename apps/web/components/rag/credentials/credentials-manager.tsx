'use client';
import { useTranslations } from 'next-intl';
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
    const tr = useTranslations('rag');
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
                <p>{tr('credentials.priority')}</p>
                <p>{tr('credentials.fallback')}</p>
                <p className='text-muted-foreground'>
                    {tr('credentials.unverified')}
                </p>
            </div>
            <div className='flex flex-wrap justify-between gap-3'>
                <CatalogSearch
                    value={page.query}
                    onChange={page.search}
                    label={tr('credentials.search')}
                />
                {canOperation('admin.rag.credentials.create') && (
                    <Button onClick={() => setEditing('new')}>
                        {tr('credentials.create')}
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
                                            {tr('credentials.revision', {
                                                provider: item.provider,
                                                revision: item.revision,
                                            })}
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
                                            ? tr('credentials.selected')
                                            : tr('credentials.notSelected')}
                                    </Badge>
                                </div>
                                <p className='break-all text-sm'>
                                    {item.data.endpoint}
                                </p>
                                {item.data.provider === 'S3' && (
                                    <p className='text-sm'>
                                        {tr('credentials.bucketSummary', {
                                            bucket: item.data.bucket,
                                            region: item.data.region,
                                        })}
                                    </p>
                                )}
                                <p className='text-xs text-muted-foreground'>
                                    {tr('credentials.masked')}
                                </p>
                                <div className='flex flex-wrap gap-2'>
                                    {canOperation(
                                        'admin.rag.credentials.update'
                                    ) && (
                                        <Button
                                            variant='outline'
                                            onClick={() => setEditing(item)}
                                        >
                                            {tr('credentials.renew')}
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
                                                {tr('credentials.select')}
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
                                            {tr('common.delete')}
                                        </Button>
                                    )}
                                </div>
                            </article>
                        ))}
                    </div>
                    {query.data.total === 0 && (
                        <p className='rounded-xl border border-dashed p-8 text-center text-muted-foreground'>
                            {tr('credentials.empty')}
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
                            ? tr('credentials.selectTitle')
                            : tr('credentials.deleteTitle')
                    }
                    description={
                        confirm.activate
                            ? tr('credentials.selectDescription', {
                                  name: confirm.item.name,
                              })
                            : tr('credentials.deleteDescription', {
                                  name: confirm.item.name,
                              })
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
