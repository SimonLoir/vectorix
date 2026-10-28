'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@repo/ui/button';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { RequestErrorState } from '@/components/request-error-state';
import {
    CollectionPicker,
    type CollectionSelection,
} from '../home/collection-picker';
import { CatalogQueryState } from '../catalog-controls';
import { ClientExamples } from './client-examples';
import type { Collection } from '../types';
import {
    selectedClientCollection,
    canCopyClientConfiguration,
    type BoundClientSelection,
} from './client-selection';

/** Build key-free connection templates from current session identity and one currently readable collection. */
export function ClientIntegrations({ active }: Readonly<{ active: boolean }>) {
    const tr = useTranslations('rag.clients');
    const { baseURL, orpc } = useORPC();
    const {
        data: session,
        isPending: sessionPending,
        isRefetching: sessionRefetching,
    } = useAuth().useSession();
    const access = useVectorixPermissions();
    const organizationId = session?.session.activeOrganizationId;
    const apiUrl = baseURL.replace(/\/+$/, '');
    const canRead = access.canOperation('retrieval.search');
    const [selection, setSelection] = useState<BoundClientSelection | null>(
        null
    );
    const selected = selectedClientCollection(selection, organizationId);
    const options = orpc.admin.rag.collections.get.queryOptions({
        input: { id: selected?.id ?? '' },
    });
    const query = useQuery({
        ...options,
        queryKey: [...options.queryKey, organizationId],
        enabled: active && Boolean(selected && organizationId) && canRead,
        retry: false,
        staleTime: 0,
    });
    const collection = query.isError ? undefined : query.data;
    const ready = canCopyClientConfiguration({
        active,
        identityReady: !sessionPending && !sessionRefetching,
        permissionsReady: !access.isPending && !access.isError,
        canRead,
        organizationId,
        selection,
        collection,
        fetching: query.isFetching,
        failed: query.isError,
    });
    return (
        <div className='min-w-0 space-y-5'>
            <section className='space-y-4 rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5'>
                <div className='space-y-2'>
                    <h2 className='text-xl font-semibold'>{tr('title')}</h2>
                    <p className='max-w-3xl text-sm text-muted-foreground'>
                        {tr('description')}
                    </p>
                </div>
                <dl className='grid gap-3 text-sm sm:grid-cols-2'>
                    <div className='min-w-0'>
                        <dt className='text-muted-foreground'>
                            {tr('apiUrl')}
                        </dt>
                        <dd className='mt-1 break-all font-mono text-xs'>
                            {apiUrl}
                        </dd>
                    </div>
                    <div className='min-w-0'>
                        <dt className='text-muted-foreground'>
                            {tr('organization')}
                        </dt>
                        <dd className='mt-1 break-all font-mono text-xs'>
                            {organizationId ?? tr('noOrganization')}
                        </dd>
                    </div>
                </dl>
                <CollectionPicker
                    selected={selected}
                    disabled={
                        !active ||
                        !organizationId ||
                        !canRead ||
                        access.isPending
                    }
                    onSelect={(collection) => {
                        if (organizationId)
                            setSelection({ organizationId, collection });
                    }}
                />
                <ClientAvailability
                    sessionPending={sessionPending}
                    organizationId={organizationId}
                    selected={selected}
                    query={query}
                />
                <p className='text-xs text-muted-foreground'>
                    {tr('noRequests')}
                </p>
            </section>
            <ClientExamples
                apiUrl={apiUrl}
                organizationId={organizationId ?? 'YOUR_ORGANIZATION_ID'}
                collectionId={
                    ready && collection ? collection.id : 'YOUR_COLLECTION_ID'
                }
                ready={ready}
            />
            <section className='space-y-4 rounded-xl border p-4 sm:p-5'>
                <details>
                    <summary className='cursor-pointer font-medium'>
                        {tr('accessTitle')}
                    </summary>
                    <div className='mt-3 space-y-3 text-sm text-muted-foreground'>
                        <p>{tr('permissions')}</p>
                        <p>{tr('scopes')}</p>
                        <p>{tr('serverOnly')}</p>
                        <p>{tr('sessionOnly')}</p>
                    </div>
                </details>
                <div className='flex flex-wrap gap-2'>
                    {access.canOperation('admin.organization.apiKeys.list') && (
                        <Button asChild variant='outline' size='sm'>
                            <Link href='/dashboard/account/api-keys'>
                                {tr('apiKeys')}
                            </Link>
                        </Button>
                    )}
                    <Button asChild variant='outline' size='sm'>
                        <a
                            href={`${apiUrl}/`}
                            target='_blank'
                            rel='noreferrer noopener'
                        >
                            {tr('apiDocs')}
                        </a>
                    </Button>
                    <Button asChild variant='outline' size='sm'>
                        <a
                            href={`${apiUrl}/spec/v1.json`}
                            target='_blank'
                            rel='noreferrer noopener'
                        >
                            {tr('openApi')}
                        </a>
                    </Button>
                </div>
            </section>
        </div>
    );
}

/** Keep permission/loading failures explicit without changing credential or key permissions. */
function ClientAvailability({
    sessionPending,
    organizationId,
    selected,
    query,
}: Readonly<{
    sessionPending: boolean;
    organizationId: string | null | undefined;
    selected: CollectionSelection | null;
    query: {
        isPending: boolean;
        isError: boolean;
        error: Error | null;
        refetch: () => unknown;
        data: Collection | undefined;
    };
}>) {
    const tr = useTranslations('rag.clients');
    const common = useTranslations('rag.common');
    const access = useVectorixPermissions();
    if (sessionPending) return <p role='status'>{common('loading')}</p>;
    if (!organizationId)
        return (
            <p role='status' className='text-sm'>
                {tr('chooseOrganization')}
            </p>
        );
    if (access.isError)
        return (
            <RequestErrorState
                errorKey={access.errorKey ?? 'generic'}
                onRetry={access.refresh}
            />
        );
    if (access.isPending) return <p role='status'>{common('loading')}</p>;
    if (!access.canOperation('retrieval.search'))
        return (
            <p role='status' className='text-sm'>
                {tr('readRequired')}
            </p>
        );
    if (!selected) return null;
    return (
        <>
            <CatalogQueryState query={query} />
            {!query.isError && query.data && !query.data.permissions.read && (
                <p role='status' className='text-sm'>
                    {tr('readRevoked')}
                </p>
            )}
        </>
    );
}
