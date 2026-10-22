'use client';
import { useTranslations, useFormatter } from 'next-intl';
import { Badge } from '@repo/ui/badge';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { ActionError, useCatalogAction } from '../catalog-action';
import type { RagOutputs } from '../types';

type Lifecycle = RagOutputs['documents']['lifecycle'];

export function DocumentVersions({ data }: Readonly<{ data: Lifecycle }>) {
    const tr = useTranslations('rag.documents');
    const format = useFormatter();
    const { client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useCatalogAction();
    return (
        <div className='space-y-3'>
            <ActionError error={action.error ? tr('actionFailed') : null} />
            {data.versions.map((version) => (
                <article
                    key={version.id}
                    className='space-y-3 rounded-lg border p-4'
                >
                    <div className='flex flex-wrap items-start justify-between gap-3'>
                        <h3 className='min-w-0 break-words font-medium'>
                            {version.fileName}
                        </h3>
                        <div className='flex flex-wrap gap-2'>
                            <Badge variant='secondary'>
                                {tr(`status.${version.status}`)}
                            </Badge>
                            {version.id === data.publishedVersionId &&
                                !data.deletedAt && (
                                    <Badge>{tr('lifecycle.published')}</Badge>
                                )}
                            {version.id === data.latestVersionId && (
                                <Badge variant='outline'>
                                    {tr('lifecycle.latest')}
                                </Badge>
                            )}
                        </div>
                    </div>
                    <p className='text-sm text-muted-foreground'>
                        {tr('versionInfo', {
                            version: version.version,
                            bytes: version.byteSize,
                            date: format.dateTime(version.createdAt, {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                            }),
                        })}
                    </p>
                    {!data.deletedAt &&
                        version.id === data.latestVersionId &&
                        version.task && (
                            <p role='status' className='text-sm'>
                                {tr(`task.${version.task.status}`, {
                                    attempts: version.task.attempts,
                                })}
                            </p>
                        )}
                    {!data.deletedAt &&
                        version.id === data.latestVersionId &&
                        (version.task?.diagnostic ??
                            version.task?.errorCode) && (
                            <p role='alert' className='text-sm'>
                                {version.task.diagnostic
                                    ? tr(
                                          `diagnostics.${version.task.diagnostic}`
                                      )
                                    : version.task.errorCode &&
                                      tr(`errors.${version.task.errorCode}`)}
                            </p>
                        )}
                    {version.cleanup && (
                        <div className='space-y-2 rounded-md bg-muted p-3 text-sm'>
                            <p>
                                {tr(
                                    `lifecycle.cleanup.${version.cleanup.status}`
                                )}
                            </p>
                            <p className='text-muted-foreground'>
                                {tr('lifecycle.cleanupSchedule', {
                                    date: format.dateTime(
                                        version.cleanup.scheduledAt,
                                        {
                                            dateStyle: 'medium',
                                            timeStyle: 'short',
                                        }
                                    ),
                                })}
                            </p>
                            {version.cleanup.errorCode && (
                                <p role='alert'>
                                    {tr(
                                        `lifecycle.cleanupErrors.${version.cleanup.errorCode}`
                                    )}
                                </p>
                            )}
                            {version.cleanup.status === 'FAILED' &&
                                canOperation(
                                    'admin.rag.documents.retryCleanup'
                                ) && (
                                    <Button
                                        size='sm'
                                        variant='outline'
                                        disabled={action.busy}
                                        onClick={() =>
                                            void action.run(() =>
                                                client.admin.rag.documents.retryCleanup(
                                                    {
                                                        id: data.document.id,
                                                        versionId: version.id,
                                                    }
                                                )
                                            )
                                        }
                                    >
                                        {tr('lifecycle.retryCleanup')}
                                    </Button>
                                )}
                        </div>
                    )}
                    {version.discardedAt && (
                        <p className='text-sm text-muted-foreground'>
                            {tr('lifecycle.discarded', {
                                date: format.dateTime(version.discardedAt, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                }),
                            })}
                        </p>
                    )}
                    {!data.deletedAt &&
                        version.id === data.latestVersionId &&
                        version.task?.status === 'FAILED' &&
                        !version.discardedAt &&
                        !version.cleanup &&
                        canOperation('admin.rag.documents.retry') && (
                            <Button
                                size='sm'
                                variant='outline'
                                disabled={action.busy}
                                onClick={() =>
                                    void action.run(() =>
                                        client.admin.rag.documents.retry({
                                            id: data.document.id,
                                        })
                                    )
                                }
                            >
                                {tr('retry')}
                            </Button>
                        )}
                </article>
            ))}
        </div>
    );
}
