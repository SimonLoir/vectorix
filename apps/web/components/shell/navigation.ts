import {
    Bell,
    Database,
    FileText,
    Gauge,
    KeyRound,
    Layers,
    ListChecks,
    Plug,
    ScrollText,
    Search,
    Shield,
    UserRound,
    Users,
    UsersRound,
    type LucideIcon,
} from 'lucide-react';
import type { PermissionSet } from '@repo/auth/permissions';

/** Translation keys under `dashboard.navigation.sections`. */
export type NavigationGroupKey =
    'workspace' | 'library' | 'organization' | 'platform' | 'personal';

/**
 * One dashboard destination. `operation` and `permission` only control
 * visibility; every page and API call still enforces its own authorization.
 */
export type NavigationItem = {
    readonly href: string;
    /** Translation key under `dashboard.navigation`. */
    readonly label: string;
    readonly icon: LucideIcon;
    readonly group: NavigationGroupKey;
    readonly operation?: string | readonly string[];
    readonly permission?: PermissionSet;
    /** Extra words matched by the command palette, in addition to the label. */
    readonly keywords?: readonly string[];
};

export const navigationGroups: readonly NavigationGroupKey[] = [
    'workspace',
    'library',
    'organization',
    'platform',
];

export const navigationItems: readonly NavigationItem[] = [
    {
        href: '/dashboard',
        label: 'home',
        icon: Search,
        group: 'workspace',
        keywords: ['search', 'retrieval'],
    },
    {
        href: '/dashboard/collections',
        label: 'collections',
        icon: Database,
        group: 'library',
        operation: 'admin.rag.collections.list',
    },
    {
        href: '/dashboard/documents',
        label: 'documents',
        icon: FileText,
        group: 'library',
        operation: 'admin.rag.documents.list',
        keywords: ['upload', 'files'],
    },
    {
        href: '/dashboard/settings/members',
        label: 'members',
        icon: Users,
        group: 'organization',
        operation: 'admin.members.get',
        keywords: ['invite'],
    },
    {
        href: '/dashboard/settings/groups',
        label: 'groups',
        icon: UsersRound,
        group: 'organization',
        operation: 'admin.rag.groups.list',
    },
    {
        href: '/dashboard/settings/roles',
        label: 'roles',
        icon: Shield,
        group: 'organization',
        permission: { ac: ['read'] },
    },
    {
        href: '/dashboard/account/api-keys',
        label: 'apiKeys',
        icon: KeyRound,
        group: 'organization',
        operation: 'admin.organization.apiKeys.list',
        keywords: ['token'],
    },
    {
        href: '/dashboard/settings/licenses',
        label: 'licenses',
        icon: Layers,
        group: 'organization',
    },
    {
        href: '/dashboard/settings/integrations',
        label: 'integrations',
        icon: Plug,
        group: 'platform',
        operation: ['admin.rag.credentials.list', 'retrieval.search'],
        keywords: ['credentials', 'provider', 'mcp'],
    },
    {
        href: '/dashboard/settings/usage',
        label: 'usage',
        icon: Gauge,
        group: 'platform',
        operation: 'admin.rag.quota',
        keywords: ['quota'],
    },
    {
        href: '/dashboard/settings/operations',
        label: 'operations',
        icon: ListChecks,
        group: 'platform',
        operation: 'admin.rag.operations.overview',
        keywords: ['tasks', 'workers'],
    },
    {
        href: '/dashboard/settings/audit',
        label: 'audit',
        icon: ScrollText,
        group: 'platform',
        operation: 'admin.rag.audit',
    },
    {
        href: '/dashboard/account',
        label: 'account',
        icon: UserRound,
        group: 'personal',
        keywords: ['profile', 'security', 'passkey'],
    },
    {
        href: '/dashboard/notifications',
        label: 'notifications',
        icon: Bell,
        group: 'personal',
    },
];

/**
 * Returns the most specific navigation item whose route contains `pathname`,
 * so `/dashboard/account/api-keys` resolves to API keys rather than Account.
 */
export function matchNavigationItem(
    pathname: string
): NavigationItem | undefined {
    let match: NavigationItem | undefined;
    for (const item of navigationItems) {
        const matches =
            pathname === item.href ||
            (item.href !== '/dashboard' &&
                pathname.startsWith(`${item.href}/`));
        if (matches && (!match || item.href.length > match.href.length)) {
            match = item;
        }
    }
    return match;
}
