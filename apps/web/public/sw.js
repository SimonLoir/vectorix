/* Vectorix notification service worker. Keep this file self-contained. */
const SERVICE_WORKER_VERSION = 'vectorix-notifications-v1';
const NOTIFICATION_FALLBACK_PATH = '/dashboard/notifications';

self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'VECTORIX_SERVICE_WORKER_VERSION') {
        event.source?.postMessage({
            type: 'VECTORIX_SERVICE_WORKER_VERSION',
            version: SERVICE_WORKER_VERSION,
        });
    }
});

function safeDashboardPath(value) {
    if (typeof value !== 'string' || !value.startsWith('/dashboard/')) {
        return NOTIFICATION_FALLBACK_PATH;
    }

    try {
        const url = new URL(value, self.location.origin);
        return url.origin === self.location.origin &&
            url.pathname.startsWith('/dashboard/')
            ? `${url.pathname}${url.search}${url.hash}`
            : NOTIFICATION_FALLBACK_PATH;
    } catch {
        return NOTIFICATION_FALLBACK_PATH;
    }
}

function parsePushPayload(event) {
    if (!event.data) return null;
    try {
        const payload = event.data.json();
        if (
            payload?.version !== 1 ||
            typeof payload.notificationId !== 'string' ||
            typeof payload.title !== 'string' ||
            typeof payload.body !== 'string'
        ) {
            return null;
        }
        return {
            notificationId: payload.notificationId,
            title: payload.title,
            body: payload.body,
            path: safeDashboardPath(payload.path),
        };
    } catch {
        return null;
    }
}

self.addEventListener('push', (event) => {
    const payload = parsePushPayload(event);
    if (!payload) return;

    event.waitUntil(
        self.registration.showNotification(payload.title, {
            body: payload.body,
            icon: '/icons/vectorix-192.png',
            badge: '/icons/notification-badge.png',
            tag: `vectorix-notification-${payload.notificationId}`,
            data: {
                notificationId: payload.notificationId,
                path: payload.path,
            },
        })
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const target = new URL(
        safeDashboardPath(event.notification.data?.path),
        self.location.origin
    );

    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            const current = windows.find((client) => {
                try {
                    return new URL(client.url).origin === self.location.origin;
                } catch {
                    return false;
                }
            });
            if (current) {
                await current.navigate(target.href);
                await current.focus();
                return;
            }
            await self.clients.openWindow(target.href);
        })()
    );
});
