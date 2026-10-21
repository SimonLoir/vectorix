'use client';

import type { ComponentProps } from 'react';
import { Button as BaseButton } from '@repo/ui/button';
import { DropdownMenuItem as BaseMenuItem } from '@repo/ui/dropdown-menu';
import { AlertDialogAction as BaseAlertAction } from '@repo/ui/alert-dialog';
import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import type { PermissionSet } from '@repo/auth/permissions';

export * from '@repo/ui/button';
export * from '@repo/ui/dropdown-menu';
export * from '@repo/ui/alert-dialog';

type ActionProps = {
    readonly operation?: string | string[];
    readonly permissions?: PermissionSet;
};

function useAllowed(
    operation: ActionProps['operation'],
    permissions?: PermissionSet
) {
    const { canOperation, can } = useVectorixPermissions();
    return (
        (!permissions || can(permissions)) &&
        (operation === undefined ||
            (Array.isArray(operation) ? operation : [operation]).every(
                canOperation
            ))
    );
}

/** Permission-aware action. Unannotated navigation/cancel buttons keep their usual behavior. */
export function Button({
    operation,
    permissions,
    ...props
}: ComponentProps<typeof BaseButton> & ActionProps) {
    const allowed = useAllowed(operation, permissions);
    return allowed ? <BaseButton {...props} /> : null;
}

/** Prevents inaccessible commands from appearing in row/action menus. */
export function DropdownMenuItem({
    operation,
    permissions,
    ...props
}: ComponentProps<typeof BaseMenuItem> & ActionProps) {
    const allowed = useAllowed(operation, permissions);
    return allowed ? <BaseMenuItem {...props} /> : null;
}

/** Rechecks permissions when a confirmation dialog remains open during a role change. */
export function AlertDialogAction({
    operation,
    permissions,
    ...props
}: ComponentProps<typeof BaseAlertAction> & ActionProps) {
    const allowed = useAllowed(operation, permissions);
    return allowed ? <BaseAlertAction {...props} /> : null;
}
