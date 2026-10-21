'use client';

import {
    createContext,
    useContext,
    useEffect,
    useRef,
    type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@repo/dashboard-core/hooks/use-auth';
import { permits, type PermissionSet } from '@repo/auth/permissions';
import { operationPermissions } from '@repo/auth/permissions/operations';
import { useORPC } from '@/hooks/use-orpc';
import type { VectorixApiV1Outputs } from '@repo/api';

type Access = VectorixApiV1Outputs['admin']['organization']['access'];
type PermissionState = {
    access: Access | undefined;
    isPending: boolean;
    isError: boolean;
    can: (permissions: PermissionSet) => boolean;
    canOperation: (operation: string) => boolean;
    refresh: () => Promise<void>;
};
const PermissionContext = createContext<PermissionState | null>(null);

/** Loads live permissions per user/organization and refreshes after focus or role changes. */
export function VectorixPermissionsProvider({
    children,
}: {
    readonly children: ReactNode;
}) {
    const auth = useAuth();
    const {
        data: session,
        isPending: sessionPending,
        isRefetching: sessionRefetching,
    } = auth.useSession();
    const { orpc } = useORPC();
    const queryClient = useQueryClient();
    const organizationId = session?.session.activeOrganizationId;
    const options = orpc.admin.organization.access.queryOptions({});
    const query = useQuery({
        ...options,
        queryKey: [
            ...options.queryKey,
            organizationId,
            session?.user.id,
            session?.session.id,
        ],
        meta: { vectorixAccess: true, vectorixScopeControl: true },
        enabled:
            !sessionPending && !sessionRefetching && Boolean(organizationId),
        staleTime: 0,
        refetchInterval: 15_000,
        refetchOnWindowFocus: 'always',
        retry: false,
    });
    const access = organizationId && !query.isError ? query.data : undefined;
    const signature = access
        ? JSON.stringify([organizationId, session?.user.id, access.permissions])
        : undefined;
    const previous = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (previous.current && previous.current !== signature) {
            // Reset observed business reads rather than deleting their live query objects.
            // Auth, features and onboarding must remain available to recover access.
            void queryClient.resetQueries({
                predicate: (entry) => entry.meta?.vectorixScopeControl !== true,
            });
        }
        previous.current = signature;
    }, [signature, organizationId, queryClient]);
    const can = (required: PermissionSet) =>
        Boolean(access && permits(access.permissions, required));
    return (
        <PermissionContext
            value={{
                access,
                isPending: query.isPending,
                isError: query.isError,
                can,
                canOperation: (operation) =>
                    Object.hasOwn(operationPermissions, operation) &&
                    can(operationPermissions[operation]!),
                refresh: async () => {
                    await queryClient.invalidateQueries();
                },
            }}
        >
            {children}
        </PermissionContext>
    );
}

/** Reads Vectorix UI permissions. The API always performs its own authoritative check. */
export function useVectorixPermissions() {
    const context = useContext(PermissionContext);
    if (!context) throw new Error('VectorixPermissionsProvider is required');
    return context;
}
