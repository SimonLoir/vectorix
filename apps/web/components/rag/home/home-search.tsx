'use client';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { RequestErrorState } from '@/components/request-error-state';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { SearchPlayground } from '../indexing/search-playground';
import {
    CollectionPicker,
    type CollectionSelection,
} from './collection-picker';
import { SelectedCollectionSearch } from './selected-collection-search';

type Authority = 'loading' | 'organization' | 'error' | 'denied' | 'ready';

/** A display preference never supplies authority; current session and permission guards gate private reads. */
function authorityState(
    sessionPending: boolean,
    organizationId: string | null | undefined,
    permissionPending: boolean,
    permissionFailed: boolean,
    permitted: boolean
): Authority {
    if (sessionPending) return 'loading';
    if (!organizationId) return 'organization';
    if (permissionFailed) return 'error';
    if (permissionPending) return 'loading';
    return permitted ? 'ready' : 'denied';
}

/** Preserve only the unsaved query across collection changes; scoped caches reset on organization changes. */
export function HomeSearch() {
    const tr = useTranslations('rag.searchHome');
    const { data: session, isPending: sessionPending } = useAuth().useSession();
    const access = useVectorixPermissions();
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<CollectionSelection | null>(null);
    const state = authorityState(
        sessionPending,
        session?.session.activeOrganizationId,
        access.isPending,
        access.isError,
        access.canOperation('admin.rag.indexing.search')
    );
    const control = (
        <CollectionPicker
            selected={selected}
            disabled={state !== 'ready'}
            onSelect={setSelected}
        />
    );
    if (state === 'ready' && selected)
        return (
            <SelectedCollectionSearch
                key={selected.id}
                selected={selected}
                query={query}
                onQueryChange={setQuery}
                collectionControl={control}
            />
        );
    let message = <p role='status'>{tr('chooseHint')}</p>;
    if (state === 'loading')
        message = <p role='status'>{tr('permissionLoading')}</p>;
    if (state === 'organization')
        message = <p role='status'>{tr('chooseOrganization')}</p>;
    if (state === 'denied') message = <p role='status'>{tr('searchDenied')}</p>;
    if (state === 'error')
        message = (
            <RequestErrorState
                errorKey={access.errorKey ?? 'generic'}
                onRetry={access.refresh}
            />
        );
    return (
        <SearchPlayground
            key={state}
            presentation='home'
            collectionId=''
            fields={{}}
            ready={false}
            activeGenerationId={null}
            query={query}
            onQueryChange={setQuery}
            collectionControl={control}
            readinessMessage={message}
        />
    );
}
