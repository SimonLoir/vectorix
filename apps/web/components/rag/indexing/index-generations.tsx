'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogDialog } from '../catalog-dialog';
import { IndexError, useIndexAction } from './index-state';
import type { Collection } from '../types';
import type { IndexStatus } from './types';

type Generation = IndexStatus['generations'][number];
export function IndexGenerations({
    collection,
    status,
}: Readonly<{ collection: Collection; status: IndexStatus }>) {
    const tr = useTranslations('rag.indexing');
    const format = useFormatter();
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const [discarding, setDiscarding] = useState<Generation | null>(null);
    const canDiscard =
        status.canRebuild && canOperation('admin.rag.indexing.discard');
    if (status.generations.length === 0) return <p>{tr('noGeneration')}</p>;
    return (
        <>
            <ul className='space-y-3'>
                {status.generations.map((generation) => {
                    const active = generation.id === status.active?.id;
                    const discardable =
                        !active &&
                        ['PROVISIONING', 'BUILDING', 'FAILED'].includes(
                            generation.status
                        );
                    return (
                        <li
                            key={generation.id}
                            className='space-y-2 rounded-lg border p-3 text-sm'
                        >
                            <p className='font-medium'>
                                {tr(`generationStatus.${generation.status}`)} ·{' '}
                                {generation.model} ·{' '}
                                {tr('dimensions', {
                                    count: generation.dimensions,
                                })}
                            </p>
                            <p className='break-all font-mono text-xs text-muted-foreground'>
                                {tr('rebuild.generation', {
                                    id: generation.id,
                                })}
                            </p>
                            <p>
                                {tr('generationProgress', {
                                    revision: generation.configurationRevision,
                                    published: generation.publishedDocuments,
                                    total: generation.totalDocuments,
                                    chunks: generation.projectedChunks,
                                })}
                            </p>
                            {generation.parentContextVersion && (
                                <p className='break-all text-xs text-muted-foreground'>
                                    {tr('parentContextVersion', {
                                        version:
                                            generation.parentContextVersion,
                                    })}
                                </p>
                            )}
                            {generation.previousGenerationId && (
                                <p className='break-all text-xs text-muted-foreground'>
                                    {tr('rebuild.predecessor', {
                                        id: generation.previousGenerationId,
                                    })}
                                </p>
                            )}
                            {active && (
                                <p className='font-medium'>
                                    {tr('rebuild.serving')}
                                </p>
                            )}
                            {generation.cleanupAfter &&
                                generation.status !== 'CLEANED' && (
                                    <p>
                                        {tr('rebuild.cleanupAfter', {
                                            date: format.dateTime(
                                                generation.cleanupAfter,
                                                {
                                                    dateStyle: 'medium',
                                                    timeStyle: 'short',
                                                }
                                            ),
                                        })}
                                    </p>
                                )}
                            {['RETIRED', 'CLEANING'].includes(
                                generation.status
                            ) && (
                                <p role='status'>
                                    {tr('rebuild.cleanupPending')}
                                </p>
                            )}
                            {generation.errorCode && (
                                <p role='alert'>
                                    {tr(`errors.${generation.errorCode}`)}
                                </p>
                            )}
                            {discardable && canDiscard && (
                                <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() => setDiscarding(generation)}
                                >
                                    {tr('rebuild.discard')}
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
            {discarding && (
                <CatalogDialog
                    title={tr('rebuild.discardTitle')}
                    description={tr('rebuild.discardDescription', {
                        id: discarding.id,
                        active: status.active ? 'yes' : 'no',
                    })}
                    onClose={() => setDiscarding(null)}
                    busy={action.busy}
                >
                    <p className='text-sm'>{tr('rebuild.discardCleanup')}</p>
                    {discarding.id === status.active?.id && (
                        <p role='status'>{tr('rebuild.serving')}</p>
                    )}
                    <IndexError error={action.error} />
                    <div className='flex flex-wrap justify-end gap-2'>
                        <Button
                            variant='outline'
                            disabled={action.busy}
                            onClick={() => setDiscarding(null)}
                        >
                            {tr('rebuild.cancel')}
                        </Button>
                        <Button
                            variant='destructive'
                            disabled={
                                action.busy ||
                                !canDiscard ||
                                discarding.id === status.active?.id
                            }
                            onClick={() =>
                                void action.run(
                                    () =>
                                        client.admin.rag.indexing.discard({
                                            collectionId: collection.id,
                                            generationId: discarding.id,
                                        }),
                                    () => setDiscarding(null)
                                )
                            }
                        >
                            {action.busy
                                ? tr('working')
                                : tr('rebuild.confirmDiscard')}
                        </Button>
                    </div>
                </CatalogDialog>
            )}
        </>
    );
}
