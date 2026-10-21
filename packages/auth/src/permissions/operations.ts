import type { PermissionSet } from './catalogue';
/** Unknown private operations fail closed. */
export const operationPermissions: Record<string, PermissionSet> = {
    'admin.organization.get': {
        settings: ['read'],
    },
    'admin.organization.features': {},
    'admin.organization.access': {},
    'admin.organization.apiKeys.list': {
        apiKey: ['read'],
    },
    'admin.organization.apiKeys.create': {
        apiKey: ['create'],
    },
    'admin.organization.apiKeys.updatePermissions': {
        apiKey: ['update'],
    },
    'admin.members.get': {
        member: ['read'],
    },
    'admin.members.me': {},
    'admin.notifications.list': {},
    'admin.notifications.unreadCount': {},
    'admin.notifications.markRead': {},
    'admin.notifications.markAllRead': {},
    'admin.notifications.preferences.get': {},
    'admin.notifications.preferences.update': {},
    'admin.notifications.pushSubscriptions.register': {},
    'admin.notifications.pushSubscriptions.revoke': {},
};
