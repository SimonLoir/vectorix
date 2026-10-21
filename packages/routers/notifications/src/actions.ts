import { adminNotificationsV1 } from './admin-v1-implementer';
import {
    listNotifications,
    markAllNotificationsRead,
    markNotificationRead,
    notificationUnreadCount,
} from './notification-service';
import {
    getNotificationPreferences,
    updateNotificationPreferences,
} from './preference-service';
import {
    registerPushSubscription,
    revokePushSubscription,
} from './push-subscription-service';

export const list = adminNotificationsV1.list.handler(({ context, input }) =>
    listNotifications(context, input)
);

export const unreadCount = adminNotificationsV1.unreadCount.handler(
    ({ context }) => notificationUnreadCount(context)
);

export const markRead = adminNotificationsV1.markRead.handler(
    ({ context, input }) => markNotificationRead(context, input)
);

export const markAllRead = adminNotificationsV1.markAllRead.handler(
    ({ context, input }) => markAllNotificationsRead(context, input)
);

export const getPreferences = adminNotificationsV1.preferences.get.handler(
    ({ context }) => getNotificationPreferences(context)
);

export const updatePreferences =
    adminNotificationsV1.preferences.update.handler(({ context, input }) =>
        updateNotificationPreferences(context, input)
    );

export const registerPush =
    adminNotificationsV1.pushSubscriptions.register.handler(
        ({ context, input }) => registerPushSubscription(context, input)
    );

export const revokePush = adminNotificationsV1.pushSubscriptions.revoke.handler(
    ({ context, input }) => revokePushSubscription(context, input)
);
