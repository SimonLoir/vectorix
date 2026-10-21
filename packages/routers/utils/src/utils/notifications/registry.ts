import type {
    NotificationAction,
    NotificationEventType,
    NotificationSource,
} from './types';
export const notificationEventRegistry = {
    ACCOUNT_SIGN_IN: {
        audiences: ['MEMBER'],
        sourceKind: 'ACCOUNT_SIGN_IN',
        requiredPermissions: {},
        requiredFeatures: [],
        defaultChannels: { IN_APP: false, EMAIL: true, PUSH: false },
    },
} as const;
/** Destinations are server-defined; event payloads cannot inject arbitrary URLs. */
export function buildNotificationAction(
    _event: NotificationEventType,
    _source: NotificationSource
): NotificationAction {
    return { kind: 'ACCOUNT', version: 1 };
}
export function notificationActionPath(
    _action: NotificationAction,
    _audience?: string
) {
    return '/dashboard/account';
}
