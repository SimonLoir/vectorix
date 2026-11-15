'use client';

import { useVectorixPermissions } from '@/contexts/vectorix-permissions';
import { navigationItems, type NavigationItem } from './navigation';

/**
 * Navigation entries the current member may open. This is a visibility filter
 * only; destination pages and API operations perform their own checks.
 */
export function useVisibleNavigation(): readonly NavigationItem[] {
    const { canOperation, can } = useVectorixPermissions();
    return navigationItems.filter((item) => {
        const operations =
            item.operation === undefined
                ? []
                : typeof item.operation === 'string'
                  ? [item.operation]
                  : item.operation;
        return (
            (operations.length === 0 || operations.some(canOperation)) &&
            (!item.permission || can(item.permission))
        );
    });
}
