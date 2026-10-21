'use client';

import type { ReactNode } from 'react';
import type { PermissionSet } from '@repo/auth/permissions';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';

/** Hides an action unless every required permission is currently granted. */
export function PermissionGate({
    permissions,
    children,
}: {
    readonly permissions: PermissionSet;
    readonly children: ReactNode;
}) {
    const { can } = useVectorixPermissions();
    return can(permissions) ? children : null;
}
