'use client';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import type { RerankAvailability } from './search-options';

/** Optional profile failures never block ordinary search or expose stale opt-in authority. */
export function useRerankProfile(collectionId: string) {
    const { orpc } = useORPC();
    const { canOperation } = useVectorixPermissions();
    const allowed =
        Boolean(collectionId) &&
        canOperation('admin.rag.reranking.extended.profile');
    const query = useQuery({
        ...orpc.admin.rag.reranking.extended.profile.queryOptions({
            input: { collectionId },
        }),
        enabled: allowed,
        retry: false,
        staleTime: 0,
        refetchOnWindowFocus: 'always',
        refetchInterval: (query) => (query.state.error ? false : 15_000),
    });
    const profile = allowed && !query.isError ? query.data : undefined;
    const available = Boolean(
        profile?.enabled &&
        profile.configuration &&
        profile.canUse &&
        canOperation('admin.rag.reranking.extended.search')
    );
    const key = [profile?.revision ?? 'none', available, query.isError].join(
        ':'
    );
    function availability(ready: boolean): RerankAvailability {
        if (!allowed) return 'denied';
        if (query.isError) return 'error';
        if (query.isPending) return 'loading';
        if (available) return ready ? 'available' : 'notReady';
        return profile?.enabled ? 'denied' : 'disabled';
    }
    return { query, profile, available, allowed, key, availability };
}
