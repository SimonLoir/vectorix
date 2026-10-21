'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useORPC } from '@/hooks/use-orpc';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';

export type VectorixFeatureKey = string;

/** Loads the active organization's effective features for dashboard UI gating. */
export function useVectorixFeatures() {
    const { orpc } = useORPC();
    const {
        data: session,
        isPending: sessionPending,
        isRefetching: sessionRefetching,
    } = useAuth().useSession();
    const organizationId = session?.session.activeOrganizationId;
    const options = orpc.admin.organization.features.queryOptions({});
    const query = useQuery({
        ...options,
        queryKey: [
            ...options.queryKey,
            organizationId,
            session?.user.id,
            session?.session.id,
        ],
        meta: { vectorixScopeControl: true },
        enabled:
            !sessionPending && !sessionRefetching && Boolean(organizationId),
        staleTime: 0,
        retry: false,
    });
    const data =
        organizationId && !sessionPending && !query.isError
            ? query.data
            : undefined;
    const enabledFeatureKeys = useMemo(
        () =>
            new Set(
                data?.features
                    .filter((feature) => feature.enabled)
                    .map((feature) => feature.key)
            ),
        [data]
    );

    return {
        isPending: sessionPending || query.isPending,
        isError: query.isError,
        refresh: () => query.refetch(),
        isFeatureEnabled: (featureKey: VectorixFeatureKey) =>
            enabledFeatureKeys.has(featureKey),
    };
}
