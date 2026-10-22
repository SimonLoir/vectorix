'use client';
import { useTranslations, useFormatter } from 'next-intl';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { Badge } from '@repo/ui/badge';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { ActionError, useCatalogAction } from '../catalog-action';
import { DocumentQueryState } from './query-state';
import { DocumentCollections } from './document-collections';
import { DocumentPreview } from './document-preview';
import { DocumentSources } from './document-sources';
import { DocumentLifecycle } from './document-lifecycle';

export function DocumentDetail({ id }: Readonly<{ id: string }>) {
    const tr = useTranslations('rag.documents');
    const format = useFormatter();
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useCatalogAction();
    const query = useQuery({
        ...orpc.admin.rag.documents.details.queryOptions({ input: { id } }),
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 3000),
    });
    const data = query.isError ? undefined : query.data;
    const version = data?.version;
    async function download() {
        const file = await client.admin.rag.documents.download({ id });
        const url = URL.createObjectURL(file);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = file.name;
        document.body.append(anchor);
        anchor.click();
        anchor.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return (
        <div className='space-y-5'>
            <Link href='/dashboard/documents' className='text-sm underline'>
                {tr('back')}
            </Link>
            <DocumentQueryState query={query} />
            {data && (
                <>
                    <section className='space-y-4 rounded-xl border bg-card p-5'>
                        <div className='flex flex-wrap items-start justify-between gap-3'>
                            <h2 className='break-words text-2xl font-semibold'>
                                {data.document.name}
                            </h2>
                            <Badge variant='secondary'>
                                {tr(`status.${data.document.status}`)}
                            </Badge>
                        </div>
                        {version && (
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
                        )}
                        {version?.task && (
                            <p role='status'>
                                {tr(`task.${version.task.status}`, {
                                    attempts: version.task.attempts,
                                })}
                            </p>
                        )}
                        {(version?.task?.diagnostic ??
                            version?.task?.errorCode) && (
                            <p role='alert' className='text-sm'>
                                {version.task.diagnostic
                                    ? tr(
                                          `diagnostics.${version.task.diagnostic}`
                                      )
                                    : version.task.errorCode &&
                                      tr(`errors.${version.task.errorCode}`)}
                            </p>
                        )}
                        <ActionError
                            error={action.error ? tr('actionFailed') : null}
                        />
                        <div className='flex flex-wrap gap-3'>
                            {version?.stored && (
                                <Button
                                    variant='outline'
                                    disabled={action.busy}
                                    onClick={() => void action.run(download)}
                                >
                                    {tr('download')}
                                </Button>
                            )}
                        </div>
                    </section>
                    {version?.previewAvailable &&
                        ([
                            'application/pdf',
                            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        ].includes(version.mediaType) ? (
                            <DocumentSources
                                key={version.id}
                                id={id}
                                expectedVersion={version.version}
                                onRefresh={() => void query.refetch()}
                            />
                        ) : (
                            <DocumentPreview key={version.id} id={id} />
                        ))}
                    {data.canManage &&
                        canOperation('admin.rag.documents.lifecycle') && (
                            <DocumentLifecycle id={id} />
                        )}
                    {data.canManage &&
                        canOperation('admin.rag.documents.setCollection') && (
                            <DocumentCollections
                                id={id}
                                ready={data.document.status === 'READY'}
                            />
                        )}
                </>
            )}
        </div>
    );
}
