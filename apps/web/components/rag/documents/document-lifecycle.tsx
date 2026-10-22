'use client';
import { useState } from 'react';
import { useTranslations, useFormatter } from 'next-intl';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { CatalogPagination } from '../catalog-controls';
import { DocumentQueryState } from './query-state';
import { DocumentReplace } from './document-replace';
import { DocumentDelete } from './document-delete';
import { DocumentVersions } from './document-versions';

/** Manager workspace includes retained metadata after content access has been revoked. */
export function DocumentLifecycle({
    id,
    deletedPage = false,
}: Readonly<{ id: string; deletedPage?: boolean }>) {
    const tr = useTranslations('rag.documents');
    const format = useFormatter();
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const [offset, setOffset] = useState(0);
    const [dialog, setDialog] = useState<{
        kind: 'replace' | 'delete';
        expectedVersionId: string;
        name: string;
    } | null>(null);
    const options = orpc.admin.rag.documents.lifecycle.queryOptions({
        input: { id, offset, limit: 10 },
    });
    const query = useQuery({
        ...options,
        // Active and deleted workspaces must not reuse each other's cached view.
        queryKey: [...options.queryKey, { deletedPage }],
        retry: false,
        staleTime: 0,
        refetchInterval: (entry) =>
            entry.state.error ||
            (deletedPage && entry.state.data && !entry.state.data.deletedAt)
                ? false
                : 3000,
    });
    const unexpectedLiveData = Boolean(
        deletedPage && query.data && !query.data.deletedAt
    );
    // A deleted-document page never renders live controls, even from stale data.
    const data = query.isError || unexpectedLiveData ? undefined : query.data;
    const queryState = {
        isError: query.isError || (unexpectedLiveData && !query.isFetching),
        isPending: query.isPending || (unexpectedLiveData && query.isFetching),
        refetch: query.refetch,
    };
    const latest = data?.versions.find(
        (version) => version.id === data.latestVersionId
    );
    const processing =
        latest?.task &&
        ['UPLOADING', 'PENDING', 'PROCESSING'].includes(latest.task.status);
    return (
        <section className='space-y-5 rounded-xl border p-5'>
            {deletedPage && (
                <Link href='/dashboard/documents' className='text-sm underline'>
                    {tr('back')}
                </Link>
            )}
            <div className='space-y-2'>
                <h2 className='break-words text-lg font-semibold'>
                    {deletedPage && data
                        ? data.document.name
                        : tr('lifecycle.title')}
                </h2>
                <p className='text-sm text-muted-foreground'>
                    {tr('lifecycle.description')}
                </p>
            </div>
            <DocumentQueryState query={queryState} />
            {data && (
                <>
                    {data.deletedAt ? (
                        <p
                            role='status'
                            className='rounded-md border p-3 text-sm'
                        >
                            {tr('lifecycle.deletedAt', {
                                date: format.dateTime(data.deletedAt, {
                                    dateStyle: 'medium',
                                    timeStyle: 'short',
                                }),
                            })}
                        </p>
                    ) : (
                        <>
                            <p className='text-sm text-muted-foreground'>
                                {tr(
                                    data.publishedVersionId
                                        ? 'lifecycle.publishedHint'
                                        : 'lifecycle.unpublishedHint'
                                )}
                            </p>
                            {data.latestVersionId && (
                                <div className='flex flex-wrap gap-3'>
                                    {canOperation(
                                        'admin.rag.documents.replace'
                                    ) && (
                                        <Button
                                            variant='outline'
                                            disabled={
                                                Boolean(processing) || !latest
                                            }
                                            onClick={() =>
                                                setDialog({
                                                    kind: 'replace',
                                                    expectedVersionId:
                                                        data.latestVersionId!,
                                                    name: data.document.name,
                                                })
                                            }
                                        >
                                            {tr('lifecycle.replace')}
                                        </Button>
                                    )}
                                    {canOperation(
                                        'admin.rag.documents.delete'
                                    ) && (
                                        <Button
                                            variant='destructive'
                                            onClick={() =>
                                                setDialog({
                                                    kind: 'delete',
                                                    expectedVersionId:
                                                        data.latestVersionId!,
                                                    name: data.document.name,
                                                })
                                            }
                                        >
                                            {tr('lifecycle.delete')}
                                        </Button>
                                    )}
                                </div>
                            )}
                            {processing && (
                                <p role='status' className='text-sm'>
                                    {tr('lifecycle.replacementPending')}
                                </p>
                            )}
                        </>
                    )}
                    <DocumentVersions data={data} />
                    <CatalogPagination
                        offset={offset}
                        total={data.total}
                        limit={10}
                        onChange={setOffset}
                    />
                    {dialog?.kind === 'replace' &&
                        data.latestVersionId &&
                        !data.deletedAt && (
                            <DocumentReplace
                                id={id}
                                expectedVersionId={dialog.expectedVersionId}
                                onClose={() => setDialog(null)}
                            />
                        )}
                    {dialog?.kind === 'delete' &&
                        data.latestVersionId &&
                        !data.deletedAt && (
                            <DocumentDelete
                                id={id}
                                name={dialog.name}
                                expectedVersionId={dialog.expectedVersionId}
                                onClose={() => setDialog(null)}
                            />
                        )}
                </>
            )}
        </section>
    );
}
