const DEVICE_ID_KEY = 'vectorix.notification-device.v1';
const RECEIPT_KEY_PREFIX = 'vectorix.notification-push-receipt.v1';

export type NotificationPushSupport =
    | Readonly<{ supported: true }>
    | Readonly<{
          supported: false;
          reason:
              | 'SERVER'
              | 'INSECURE_CONTEXT'
              | 'NOTIFICATION_API'
              | 'SERVICE_WORKER'
              | 'PUSH_MANAGER';
      }>;

export type NotificationPushReceipt = Readonly<{
    id: string;
    version: number;
    deviceId: string;
    /** A confirmed revoke may precede a failed browser unsubscribe. */
    serverRevoked?: true;
}>;

export function notificationPushSupport(): NotificationPushSupport {
    if (globalThis.window === undefined)
        return { supported: false, reason: 'SERVER' };
    if (!globalThis.window.isSecureContext)
        return { supported: false, reason: 'INSECURE_CONTEXT' };
    if (!('Notification' in globalThis.window))
        return { supported: false, reason: 'NOTIFICATION_API' };
    if (!('serviceWorker' in navigator))
        return { supported: false, reason: 'SERVICE_WORKER' };
    if (!('PushManager' in globalThis.window))
        return { supported: false, reason: 'PUSH_MANAGER' };
    return { supported: true };
}

export function notificationPushDeviceId() {
    const current = globalThis.localStorage.getItem(DEVICE_ID_KEY);
    if (current) return current;
    const created = globalThis.crypto.randomUUID();
    globalThis.localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
}

function receiptKey(userId: string, organizationId: string) {
    return `${RECEIPT_KEY_PREFIX}:${userId}:${organizationId}`;
}

export function readNotificationPushReceipt(
    userId: string,
    organizationId: string
): NotificationPushReceipt | null {
    try {
        const value = globalThis.localStorage.getItem(
            receiptKey(userId, organizationId)
        );
        if (!value) return null;
        const parsed = JSON.parse(value) as unknown;
        if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !('id' in parsed) ||
            typeof parsed.id !== 'string' ||
            parsed.id.length === 0 ||
            parsed.id.length > 191 ||
            !('version' in parsed) ||
            typeof parsed.version !== 'number' ||
            !Number.isSafeInteger(parsed.version) ||
            parsed.version < 1 ||
            !('deviceId' in parsed) ||
            typeof parsed.deviceId !== 'string' ||
            parsed.deviceId.length === 0 ||
            parsed.deviceId.length > 191
        )
            return null;
        return {
            id: parsed.id,
            version: parsed.version,
            deviceId: parsed.deviceId,
            ...('serverRevoked' in parsed && parsed.serverRevoked === true
                ? { serverRevoked: true as const }
                : {}),
        };
    } catch {
        return null;
    }
}

export function writeNotificationPushReceipt(
    userId: string,
    organizationId: string,
    receipt: NotificationPushReceipt
) {
    globalThis.localStorage.setItem(
        receiptKey(userId, organizationId),
        JSON.stringify(receipt)
    );
}

export function clearNotificationPushReceipt(
    userId: string,
    organizationId: string
) {
    globalThis.localStorage.removeItem(receiptKey(userId, organizationId));
}

function applicationServerKey(publicKey: string) {
    const padding = '='.repeat((4 - (publicKey.length % 4)) % 4);
    const base64 = (publicKey + padding)
        .replaceAll('-', '+')
        .replaceAll('_', '/');
    const decoded = globalThis.atob(base64);
    return Uint8Array.from(
        decoded,
        (character) => character.codePointAt(0) ?? 0
    );
}

export async function currentNotificationPushSubscription() {
    const support = notificationPushSupport();
    if (!support.supported) return null;
    const registration = await navigator.serviceWorker.getRegistration('/');
    return registration ? registration.pushManager.getSubscription() : null;
}

/** Reuses an existing subscription without making rollback affect other scopes. */
export async function subscribeToNotifications(publicKey: string) {
    const support = notificationPushSupport();
    if (!support.supported)
        throw new Error(`PUSH_UNSUPPORTED:${support.reason}`);
    const permission =
        Notification.permission === 'default'
            ? await Notification.requestPermission()
            : Notification.permission;
    if (permission !== 'granted')
        throw new Error(`PUSH_PERMISSION_${permission.toUpperCase()}`);
    const registration = await navigator.serviceWorker.getRegistration('/');
    if (!registration?.active) throw new Error('PUSH_WORKER_UNAVAILABLE');
    const current = await registration.pushManager.getSubscription();
    if (current) return { subscription: current, created: false };
    return {
        subscription: await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey(publicKey),
        }),
        created: true,
    };
}

/** null means this browser cannot confirm local cleanup; false is not success. */
export async function unsubscribeFromNotifications() {
    if (!notificationPushSupport().supported) return null;
    const subscription = await currentNotificationPushSubscription();
    return subscription ? subscription.unsubscribe() : true;
}

export function notificationPushRegistrationInput({
    organizationId,
    deviceId,
    subscription,
}: Readonly<{
    organizationId: string;
    deviceId: string;
    subscription: PushSubscription;
}>) {
    const serialized = subscription.toJSON();
    if (
        !serialized.endpoint ||
        !serialized.keys?.p256dh ||
        !serialized.keys.auth
    )
        throw new Error('PUSH_SUBSCRIPTION_INCOMPLETE');
    return {
        expectedOrganizationId: organizationId,
        application: 'VECTORIX_DASHBOARD' as const,
        deviceId,
        endpoint: serialized.endpoint,
        expirationTime: subscription.expirationTime
            ? new Date(subscription.expirationTime)
            : null,
        keys: {
            p256dh: serialized.keys.p256dh,
            auth: serialized.keys.auth,
        },
    };
}
