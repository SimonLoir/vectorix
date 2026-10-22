'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { RebuildDialog, type RebuildReview } from './rebuild-dialog';
import { IndexGenerations } from './index-generations';
import { ModelVerification } from './model-verification';
import { ProfileSummary } from '../collections/profile-summary';
import { IndexError, useIndexAction } from './index-state';
import type { Collection, RagOutputs } from '../types';
import type { IndexStatus } from './types';

export function IndexControls({
    collection,
    status,
}: Readonly<{ collection: Collection; status: IndexStatus }>) {
    const tr = useTranslations('rag.indexing');
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const [probe, setProbe] = useState<{
        revision: number;
        result: RagOutputs['indexing']['probe'];
    } | null>(null);
    const [review, setReview] = useState<RebuildReview | null>(null);
    const building = status.generations.some((generation) =>
        ['PROVISIONING', 'BUILDING'].includes(generation.status)
    );
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h3 className='font-semibold'>{tr('operations')}</h3>
            <p className='text-sm text-muted-foreground'>
                {tr('savedRevisionHint', {
                    revision: collection.configurationRevision,
                })}
            </p>
            {status.active && (
                <div
                    className='space-y-2 rounded-lg bg-muted p-4 text-sm'
                    role='status'
                >
                    <p className='font-medium'>
                        {tr('rebuild.activeAvailable', {
                            revision: status.active.configurationRevision,
                            model: status.active.model,
                            dimensions: status.active.dimensions,
                        })}
                    </p>
                    <p>
                        {tr('rebuild.draftState', {
                            revision: collection.configurationRevision,
                            same:
                                status.active.configurationRevision ===
                                collection.configurationRevision
                                    ? 'yes'
                                    : 'no',
                        })}
                    </p>
                </div>
            )}
            {status.unsupportedReason && (
                <p role='status'>{tr(`errors.${status.unsupportedReason}`)}</p>
            )}
            {!status.canManage && <p>{tr('manageDenied')}</p>}
            <div className='flex flex-wrap gap-2'>
                {status.canManage &&
                    canOperation('admin.rag.indexing.probe') && (
                        <Button
                            variant='outline'
                            disabled={
                                action.busy || Boolean(status.unsupportedReason)
                            }
                            onClick={() =>
                                void action.run(
                                    () =>
                                        client.admin.rag.indexing.probe({
                                            collectionId: collection.id,
                                            expectedRevision:
                                                collection.configurationRevision,
                                        }),
                                    (result) =>
                                        setProbe({
                                            revision:
                                                collection.configurationRevision,
                                            result,
                                        }),
                                    false
                                )
                            }
                        >
                            {action.busy ? tr('working') : tr('probe')}
                        </Button>
                    )}
                {!status.active &&
                    status.canManage &&
                    canOperation('admin.rag.indexing.start') && (
                        <Button
                            disabled={
                                action.busy ||
                                status.generations.some(
                                    (generation) =>
                                        generation.status !== 'CLEANED'
                                ) ||
                                Boolean(status.active) ||
                                Boolean(status.unsupportedReason)
                            }
                            onClick={() =>
                                void action.run(() =>
                                    client.admin.rag.indexing.start({
                                        collectionId: collection.id,
                                        expectedRevision:
                                            collection.configurationRevision,
                                        requestId: crypto.randomUUID(),
                                    })
                                )
                            }
                        >
                            {building ? tr('building') : tr('start')}
                        </Button>
                    )}
                {status.active &&
                    status.activeConfiguration &&
                    status.canRebuild &&
                    canOperation('admin.rag.indexing.rebuild') && (
                        <Button
                            disabled={
                                action.busy ||
                                Boolean(status.rebuildBlockedReason) ||
                                Boolean(status.unsupportedReason)
                            }
                            onClick={() => {
                                if (
                                    !status.active ||
                                    !status.activeConfiguration
                                )
                                    return;
                                setReview({
                                    collectionId: collection.id,
                                    revision: collection.configurationRevision,
                                    activeGenerationId: status.active.id,
                                    activeRevision:
                                        status.active.configurationRevision,
                                    activeConfiguration:
                                        status.activeConfiguration,
                                    draftConfiguration:
                                        collection.configuration,
                                });
                            }}
                        >
                            {tr('rebuild.review')}
                        </Button>
                    )}
            </div>
            {status.active && status.activeConfiguration && (
                <details className='space-y-4 rounded-lg border p-4'>
                    <summary className='cursor-pointer font-medium'>
                        {tr('rebuild.activeProfile', {
                            revision: status.active.configurationRevision,
                        })}
                    </summary>
                    <ProfileSummary
                        configuration={status.activeConfiguration}
                    />
                </details>
            )}
            {status.active &&
                status.rebuildBlockedReason &&
                status.rebuildBlockedReason !== status.unsupportedReason && (
                    <p role='status' className='rounded-lg border p-3 text-sm'>
                        {tr(`errors.${status.rebuildBlockedReason}`)}
                    </p>
                )}
            {status.active && !status.canRebuild && (
                <p className='text-sm text-muted-foreground'>
                    {tr('rebuild.denied')}
                </p>
            )}
            <p className='text-xs text-muted-foreground'>
                {tr(status.active ? 'activeHint' : 'startHint')}
            </p>
            {!status.active &&
                !building &&
                status.generations.some(
                    (generation) => generation.status !== 'CLEANED'
                ) && (
                    <p role='status' className='text-sm'>
                        {tr('rebuild.startNeedsDiscard')}
                    </p>
                )}
            <IndexError error={action.error} />
            {probe?.revision === collection.configurationRevision &&
                probe.result.provider === collection.configuration.provider && (
                    <ModelVerification
                        result={probe.result}
                        revision={probe.revision}
                    />
                )}
            <p className='text-sm'>
                {tr('usage', {
                    active: status.usage.activeChunks,
                    retained: status.usage.retainedChunks,
                    reserved: status.usage.reservedChunks,
                    limit: status.usage.activeLimit,
                    temporary: status.usage.temporaryLimit,
                })}
            </p>
            <IndexGenerations collection={collection} status={status} />
            {review && (
                <RebuildDialog
                    review={review}
                    blockedReason={status.rebuildBlockedReason}
                    onClose={() => setReview(null)}
                />
            )}
        </section>
    );
}
