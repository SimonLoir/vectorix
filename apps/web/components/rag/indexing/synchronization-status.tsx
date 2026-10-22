'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { SynchronizationAdoptionDialog } from './synchronization-adoption-dialog';
import type { IndexStatus } from './types';

type Generation = IndexStatus['generations'][number];

/** Only live-generation metadata is shown; absent private CAS tokens never become null. */
export function SynchronizationStatus({
    collectionId,
    generation,
    canRebuild,
}: Readonly<{
    collectionId: string;
    generation: Generation;
    canRebuild: boolean;
}>) {
    const tr = useTranslations('rag.indexing.synchronization');
    const format = useFormatter();
    const { canOperation } = useVectorixPermissions();
    const [expected, setExpected] = useState<{
        authorityUserId: string | null;
    } | null>(null);
    const synchronization = generation.synchronization;
    if (!synchronization) return null;
    const pendingRebuild =
        Boolean(generation.previousGenerationId) &&
        ['PROVISIONING', 'BUILDING', 'FAILED'].includes(generation.status);
    const canAdopt =
        synchronization.canAdopt &&
        synchronization.authorityUserId !== undefined &&
        (!pendingRebuild || canRebuild) &&
        canOperation('admin.rag.indexing.adoptSynchronization');
    const date = (value: Date) =>
        format.dateTime(value, {
            dateStyle: 'medium',
            timeStyle: 'short',
        });
    return (
        <section className='space-y-2 rounded-lg bg-muted/40 p-3'>
            <h4 className='font-medium'>{tr('title')}</h4>
            <p>{tr(`states.${synchronization.authorityState}`)}</p>
            {synchronization.isCurrentUser && <p>{tr('yourAccount')}</p>}
            <p className='text-muted-foreground'>
                {tr(`hints.${synchronization.authorityState}`)}
            </p>
            <p>
                {tr('counts', {
                    pending: synchronization.pendingDocuments,
                    blocked: synchronization.blockedTasks,
                })}
            </p>
            <p>
                {synchronization.oldestPendingAt
                    ? tr('oldestPending', {
                          date: date(synchronization.oldestPendingAt),
                      })
                    : tr('noPendingDate')}
            </p>
            <p>
                {synchronization.lastPublishedAt
                    ? tr('lastPublished', {
                          date: date(synchronization.lastPublishedAt),
                      })
                    : tr('neverPublished')}
            </p>
            <p className='text-xs text-muted-foreground'>
                {tr('metadataHint')}
            </p>
            {pendingRebuild &&
                !canRebuild &&
                synchronization.authorityUserId !== undefined && (
                    <p>{tr('rebuildRights')}</p>
                )}
            {canAdopt && (
                <Button
                    size='sm'
                    variant='outline'
                    onClick={() => {
                        if (synchronization.authorityUserId !== undefined)
                            setExpected({
                                authorityUserId:
                                    synchronization.authorityUserId,
                            });
                    }}
                >
                    {tr('adopt')}
                </Button>
            )}
            {expected && (
                <SynchronizationAdoptionDialog
                    collectionId={collectionId}
                    generationId={generation.id}
                    expectedAuthorityUserId={expected.authorityUserId}
                    currentAuthorityUserId={synchronization.authorityUserId}
                    canAdopt={canAdopt}
                    pendingRebuild={pendingRebuild}
                    onClose={() => setExpected(null)}
                />
            )}
        </section>
    );
}
