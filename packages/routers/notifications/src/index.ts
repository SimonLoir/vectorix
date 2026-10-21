import { authorized } from '@routers/utils/authorized';
import {
    getPreferences,
    list,
    markAllRead,
    markRead,
    registerPush,
    revokePush,
    unreadCount,
    updatePreferences,
} from './actions';

export const notificationsRouter = authorized
    .prefix('/notifications')
    .tag('Notifications')
    .router({
        list,
        unreadCount,
        markRead,
        markAllRead,
        preferences: authorized.router({
            get: getPreferences,
            update: updatePreferences,
        }),
        pushSubscriptions: authorized.router({
            register: registerPush,
            revoke: revokePush,
        }),
    });
