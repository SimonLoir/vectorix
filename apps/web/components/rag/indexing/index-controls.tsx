'use client';
import { useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { IndexError, useIndexAction } from './index-state';
import type { Collection, RagOutputs } from '../types';
import type { IndexStatus } from './types';

export function IndexControls({
    collection,
    status,
}: Readonly<{ collection: Collection; status: IndexStatus }>) {
    const tr = useTranslations('rag.indexing');
    const format = useFormatter();
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const [probe, setProbe] = useState<RagOutputs['indexing']['probe'] | null>(
        null
    );
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
                                    setProbe,
                                    false
                                )
                            }
                        >
                            {action.busy ? tr('working') : tr('probe')}
                        </Button>
                    )}
                {status.canManage &&
                    canOperation('admin.rag.indexing.start') && (
                        <Button
                            disabled={
                                action.busy ||
                                building ||
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
            </div>
            <p className='text-xs text-muted-foreground'>
                {tr(status.active ? 'activeHint' : 'startHint')}
            </p>
            <IndexError error={action.error} />
            {probe && (
                <dl className='grid gap-3 rounded-lg bg-muted p-4 text-sm sm:grid-cols-2'>
                    <div>
                        <dt>{tr('verifiedModel')}</dt>
                        <dd className='break-all font-medium'>{probe.model}</dd>
                    </div>
                    <div>
                        <dt>{tr('verifiedDimensions')}</dt>
                        <dd>
                            {tr('dimensionChoices', {
                                current: probe.dimensions,
                                choices: probe.supportedDimensions
                                    .map((value) => format.number(value))
                                    .join(', '),
                            })}
                        </dd>
                    </div>
                    <div>
                        <dt>{tr('context')}</dt>
                        <dd>{tr('tokens', { count: probe.contextTokens })}</dd>
                    </div>
                    <div>
                        <dt>{tr('digest')}</dt>
                        <dd className='break-all font-mono text-xs'>
                            {probe.digest}
                        </dd>
                    </div>
                </dl>
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
            {status.generations.length === 0 ? (
                <p>{tr('noGeneration')}</p>
            ) : (
                <ul className='space-y-3'>
                    {status.generations.map((generation) => (
                        <li
                            key={generation.id}
                            className='rounded-lg border p-3 text-sm'
                        >
                            <p className='font-medium'>
                                {tr(`generationStatus.${generation.status}`)} ·{' '}
                                {generation.model} ·{' '}
                                {tr('dimensions', {
                                    count: generation.dimensions,
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
                            {generation.errorCode && (
                                <p role='alert'>
                                    {tr(`errors.${generation.errorCode}`)}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
