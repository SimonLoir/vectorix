'use client';
import { useFormatter, useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import {
    CatalogSearch,
    CatalogPagination,
    useCatalogPagination,
} from '../catalog-controls';
import { IndexQueryState, IndexError, useIndexAction } from './index-state';

export function IndexTasks({
    collectionId,
    canManage,
}: Readonly<{ collectionId: string; canManage: boolean }>) {
    const tr = useTranslations('rag.indexing');
    const format = useFormatter();
    const { orpc, client } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const action = useIndexAction();
    const page = useCatalogPagination();
    const query = useQuery({
        ...orpc.admin.rag.indexing.tasks.queryOptions({
            input: {
                collectionId,
                query: page.query,
                offset: page.offset,
                limit: page.limit,
            },
        }),
        retry: false,
        staleTime: 0,
        refetchInterval: (query) => (query.state.error ? false : 3000),
    });
    const data = query.isError ? undefined : query.data;
    return (
        <section className='space-y-4 rounded-xl border p-5'>
            <h3 className='font-semibold'>{tr('tasks')}</h3>
            <CatalogSearch
                value={page.query}
                onChange={page.search}
                label={tr('taskSearch')}
            />
            <IndexQueryState query={query} />
            <IndexError error={action.error} />
            {data && (
                <>
                    <ul className='space-y-3'>
                        {data.items.map((task) => (
                            <li
                                key={task.id}
                                className='space-y-2 rounded-lg border p-3 text-sm'
                            >
                                <p className='font-medium'>
                                    {tr(`taskKinds.${task.kind}`)} ·{' '}
                                    {tr(`taskStatus.${task.status}`)}
                                </p>
                                <p className='break-all text-xs text-muted-foreground'>
                                    {tr('rebuild.generation', {
                                        id: task.generationId,
                                    })}
                                </p>
                                <p>
                                    {tr('taskProgress', {
                                        attempts: task.attempts,
                                        chunks: task.completedChunks,
                                        reserved: task.reservedChunks,
                                        updated: format.dateTime(
                                            task.updatedAt,
                                            {
                                                dateStyle: 'short',
                                                timeStyle: 'short',
                                            }
                                        ),
                                    })}
                                </p>
                                {task.errorCode && (
                                    <p role='alert'>
                                        {tr(`errors.${task.errorCode}`)}
                                    </p>
                                )}
                                {task.retryable &&
                                    canManage &&
                                    canOperation(
                                        'admin.rag.indexing.retry'
                                    ) && (
                                        <Button
                                            size='sm'
                                            variant='outline'
                                            disabled={action.busy}
                                            onClick={() =>
                                                void action.run(() =>
                                                    client.admin.rag.indexing.retry(
                                                        {
                                                            collectionId,
                                                            taskId: task.id,
                                                        }
                                                    )
                                                )
                                            }
                                        >
                                            {tr('retryTask')}
                                        </Button>
                                    )}
                            </li>
                        ))}
                    </ul>
                    <CatalogPagination
                        offset={page.offset}
                        total={data.total}
                        limit={page.limit}
                        onChange={page.setOffset}
                    />
                </>
            )}
        </section>
    );
}
