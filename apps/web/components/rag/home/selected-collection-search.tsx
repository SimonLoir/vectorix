'use client';
import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { requestErrorKey } from '@repo/dashboard-core/lib/request-errors';
import { RequestErrorState } from '@/components/request-error-state';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { SearchPlayground } from '../indexing/search-playground';
import type { Collection } from '../types';
import type { IndexStatus } from '../indexing/types';
import type { CollectionSelection } from './collection-picker';

type Readiness =
    | 'collection-loading'
    | 'collection-error'
    | 'read-denied'
    | 'status-loading'
    | 'status-error'
    | 'not-ready'
    | 'ready';

/** Fail closed on current read/status failures while letting a serving generation outlive its draft. */
function searchReadiness({
    collection,
    collectionPending,
    collectionFailed,
    status,
    statusPending,
    statusFailed,
    statusAllowed,
}: Readonly<{
    collection: Collection | undefined;
    collectionPending: boolean;
    collectionFailed: boolean;
    status: IndexStatus | undefined;
    statusPending: boolean;
    statusFailed: boolean;
    statusAllowed: boolean;
}>): Readiness {
    if (collectionFailed) return 'collection-error';
    if (collectionPending || !collection) return 'collection-loading';
    if (!collection.permissions.read || !statusAllowed) return 'read-denied';
    if (statusFailed) return 'status-error';
    if (statusPending || !status) return 'status-loading';
    if (!status.canRead) return 'read-denied';
    return status.active?.status === 'ACTIVE' && status.activeConfiguration
        ? 'ready'
        : 'not-ready';
}

/** Only the selected readable collection receives status queries; no picker-wide status fanout. */
export function SelectedCollectionSearch({
    selected,
    query,
    onQueryChange,
    collectionControl,
}: Readonly<{
    selected: CollectionSelection;
    query: string;
    onQueryChange: (query: string) => void;
    collectionControl: ReactNode;
}>) {
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const collectionQuery = useQuery({
        ...orpc.admin.rag.collections.get.queryOptions({
            input: { id: selected.id },
        }),
        staleTime: 0,
        retry: false,
    });
    const collection = collectionQuery.isError
        ? undefined
        : collectionQuery.data;
    const statusAllowed = canOperation('admin.rag.indexing.status');
    const statusQuery = useQuery({
        ...orpc.admin.rag.indexing.status.queryOptions({
            input: { collectionId: selected.id },
        }),
        enabled: Boolean(collection?.permissions.read) && statusAllowed,
        staleTime: 0,
        retry: false,
        refetchInterval: (entry) => (entry.state.error ? false : 3000),
    });
    const status = statusQuery.isError ? undefined : statusQuery.data;
    const readiness = searchReadiness({
        collection,
        collectionPending: collectionQuery.isPending,
        collectionFailed: collectionQuery.isError,
        status,
        statusPending: statusQuery.isPending,
        statusFailed: statusQuery.isError,
        statusAllowed,
    });
    return (
        <SearchPlayground
            key={selected.id + ':' + readiness}
            presentation='home'
            collectionId={selected.id}
            fields={status?.activeConfiguration?.metadataFields ?? {}}
            ready={readiness === 'ready'}
            activeGenerationId={status?.active?.id ?? null}
            query={query}
            onQueryChange={onQueryChange}
            collectionControl={collectionControl}
            readinessMessage={
                <SelectedCollectionReadiness
                    state={readiness}
                    collectionId={selected.id}
                    collectionError={collectionQuery.error}
                    statusError={statusQuery.error}
                    onRetryCollection={collectionQuery.refetch}
                    onRetryStatus={statusQuery.refetch}
                />
            }
        />
    );
}

function SelectedCollectionReadiness({
    state,
    collectionId,
    collectionError,
    statusError,
    onRetryCollection,
    onRetryStatus,
}: Readonly<{
    state: Readiness;
    collectionId: string;
    collectionError: unknown;
    statusError: unknown;
    onRetryCollection: () => unknown;
    onRetryStatus: () => unknown;
}>) {
    const tr = useTranslations('rag.searchHome');
    if (state === 'collection-error')
        return (
            <RequestErrorState
                errorKey={requestErrorKey(collectionError)}
                onRetry={onRetryCollection}
            />
        );
    if (state === 'status-error')
        return (
            <RequestErrorState
                errorKey={requestErrorKey(statusError)}
                onRetry={onRetryStatus}
            />
        );
    if (state === 'collection-loading')
        return <p role='status'>{tr('loadingCollection')}</p>;
    if (state === 'status-loading')
        return <p role='status'>{tr('loadingIndex')}</p>;
    if (state === 'read-denied') return <p role='status'>{tr('readDenied')}</p>;
    if (state === 'not-ready')
        return (
            <div
                role='status'
                className='flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4 text-sm'
            >
                <p>{tr('notIndexed')}</p>
                <Button asChild variant='outline' size='sm'>
                    <Link href={'/dashboard/collections/' + collectionId}>
                        {tr('openCollection')}
                    </Link>
                </Button>
            </div>
        );
    return null;
}
