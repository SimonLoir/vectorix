import { oc } from '@orpc/contract';
import { z } from 'zod';

export const VECTORIX_NOTIFICATION_LIST_MAX_LIMIT_V1 = 100 as const;

export const VectorixNotificationEventTypeV1Schema = z.enum([
    'ACCOUNT_SIGN_IN',
]);

export const VectorixNotificationChannelV1Schema = z.enum([
    'IN_APP',
    'PUSH',
    'EMAIL',
]);

export const VECTORIX_NOTIFICATION_PREFERENCE_MAX_CHANGES_V1 =
    VectorixNotificationEventTypeV1Schema.options.length *
    VectorixNotificationChannelV1Schema.options.length;

export const VectorixNotificationSourceKindV1Schema = z.enum([
    'ACCOUNT_SIGN_IN',
]);

export const VectorixNotificationSourceV1Schema = z
    .object({
        kind: VectorixNotificationSourceKindV1Schema,
        id: z.string().min(1).max(500),
        version: z.number().int().positive(),
    })
    .strict();

/** Sign-in notice, opened on the member's own account page. */
const AccountNotificationActionV1Schema = z
    .object({
        kind: z.literal('ACCOUNT'),
        version: z.literal(1),
    })
    .strict();

export const VectorixNotificationActionV1Schema =
    AccountNotificationActionV1Schema;

export const VectorixNotificationV1Schema = z
    .object({
        id: z.string(),
        sequence: z.number().int().positive(),
        eventType: VectorixNotificationEventTypeV1Schema,
        occurredAt: z.date(),
        actorMemberId: z.string().nullable(),
        title: z.string().min(1).max(200),
        body: z.string().min(1).max(2000),
        source: VectorixNotificationSourceV1Schema,
        action: VectorixNotificationActionV1Schema,
        readAt: z.date().nullable(),
        createdAt: z.date(),
    })
    .strict();

export const VectorixNotificationCursorV1Schema = z
    .object({
        sequence: z.number().int().positive(),
    })
    .strict();

export const VectorixNotificationListV1Schema = z
    .object({
        cursor: VectorixNotificationCursorV1Schema.optional(),
        limit: z
            .number()
            .int()
            .min(1)
            .max(VECTORIX_NOTIFICATION_LIST_MAX_LIMIT_V1)
            .default(50),
        unreadOnly: z.boolean().default(false),
        eventTypes: z
            .array(VectorixNotificationEventTypeV1Schema)
            .min(1)
            .max(VectorixNotificationEventTypeV1Schema.options.length)
            .refine((values) => new Set(values).size === values.length, {
                message: 'Notification event types must be unique.',
            })
            .optional(),
    })
    .strict();

export const VectorixNotificationListResultV1Schema = z
    .object({
        notifications: z.array(VectorixNotificationV1Schema),
        nextCursor: VectorixNotificationCursorV1Schema.nullable(),
        watermark: z.number().int().nonnegative(),
    })
    .strict();

export const VectorixNotificationUnreadCountV1Schema = z
    .object({
        count: z.number().int().nonnegative(),
        watermark: z.number().int().nonnegative(),
    })
    .strict();

export const VectorixNotificationPreferenceV1Schema = z
    .object({
        eventType: VectorixNotificationEventTypeV1Schema,
        channel: VectorixNotificationChannelV1Schema,
        enabled: z.boolean(),
        defaultEnabled: z.boolean(),
        version: z.number().int().positive().nullable(),
        updatedAt: z.date().nullable(),
    })
    .strict();

const NotificationPreferenceChangeV1Schema = z
    .object({
        eventType: VectorixNotificationEventTypeV1Schema,
        channel: VectorixNotificationChannelV1Schema,
        enabled: z.boolean(),
        expectedVersion: z.number().int().positive().nullable(),
    })
    .strict();

export const VectorixNotificationPreferencesV1Schema = z
    .object({
        preferences: z
            .array(VectorixNotificationPreferenceV1Schema)
            .max(VECTORIX_NOTIFICATION_PREFERENCE_MAX_CHANGES_V1),
    })
    .strict();

export const VectorixNotificationPreferenceUpdateV1Schema = z
    .object({
        expectedOrganizationId: z.string().min(1),
        changes: z
            .array(NotificationPreferenceChangeV1Schema)
            .min(1)
            .max(VECTORIX_NOTIFICATION_PREFERENCE_MAX_CHANGES_V1),
    })
    .strict()
    .refine(
        ({ changes }) =>
            new Set(
                changes.map(({ eventType, channel }) =>
                    [eventType, channel].join(':')
                )
            ).size === changes.length,
        {
            path: ['changes'],
            message: 'A preference can only be changed once per request.',
        }
    );

export const VectorixNotificationPushApplicationV1Schema =
    z.literal('VECTORIX_DASHBOARD');

export const VectorixNotificationPushSubscriptionV1Schema = z
    .object({
        id: z.string(),
        application: VectorixNotificationPushApplicationV1Schema,
        deviceId: z.string().min(1).max(191),
        expirationTime: z.date().nullable(),
        version: z.number().int().positive(),
        createdAt: z.date(),
        updatedAt: z.date(),
    })
    .strict();

export const VectorixNotificationPushRegisterV1Schema = z
    .object({
        expectedOrganizationId: z.string().min(1),
        application: VectorixNotificationPushApplicationV1Schema,
        deviceId: z.string().min(1).max(191),
        endpoint: z
            .string()
            .url()
            .max(2048)
            .refine((value) => value.startsWith('https://'), {
                message: 'Push subscription endpoints must use HTTPS.',
            }),
        expirationTime: z.date().nullable(),
        keys: z
            .object({
                p256dh: z.string().min(1).max(512),
                auth: z.string().min(1).max(512),
            })
            .strict(),
    })
    .strict();

export const VectorixNotificationPushRevokeV1Schema = z
    .object({
        id: z.string().min(1),
        expectedOrganizationId: z.string().min(1),
        expectedVersion: z.number().int().positive(),
    })
    .strict();

const ExpectedOrganizationV1Schema = z
    .object({
        expectedOrganizationId: z.string().min(1),
    })
    .strict();

export const adminNotificationsV1Contract = {
    list: oc
        .route({
            method: 'GET',
            path: '/',
            description:
                'List the signed-in member’s notification inbox by descending server sequence.',
        })
        .input(
            VectorixNotificationListV1Schema.default({
                limit: 50,
                unreadOnly: false,
            })
        )
        .output(VectorixNotificationListResultV1Schema),
    unreadCount: oc
        .route({ method: 'GET', path: '/unread-count' })
        .input(z.object({}).strict().default({}))
        .output(VectorixNotificationUnreadCountV1Schema),
    markRead: oc
        .route({ method: 'POST', path: '/{id}/read' })
        .input(
            ExpectedOrganizationV1Schema.extend({
                id: z.string().min(1),
            })
        )
        .output(
            z
                .object({
                    id: z.string(),
                    readAt: z.date(),
                })
                .strict()
        ),
    markAllRead: oc
        .route({ method: 'POST', path: '/read-all' })
        .input(
            ExpectedOrganizationV1Schema.extend({
                watermark: z.number().int().nonnegative(),
            })
        )
        .output(
            z
                .object({
                    watermark: z.number().int().nonnegative(),
                    readAt: z.date(),
                    updatedCount: z.number().int().nonnegative(),
                })
                .strict()
        ),
    preferences: {
        get: oc
            .route({ method: 'GET', path: '/preferences' })
            .input(z.object({}).strict().default({}))
            .output(VectorixNotificationPreferencesV1Schema),
        update: oc
            .route({ method: 'PUT', path: '/preferences' })
            .input(VectorixNotificationPreferenceUpdateV1Schema)
            .output(VectorixNotificationPreferencesV1Schema),
    },
    pushSubscriptions: {
        register: oc
            .route({ method: 'PUT', path: '/push-subscriptions' })
            .input(VectorixNotificationPushRegisterV1Schema)
            .output(VectorixNotificationPushSubscriptionV1Schema),
        revoke: oc
            .route({ method: 'DELETE', path: '/push-subscriptions/{id}' })
            .input(VectorixNotificationPushRevokeV1Schema)
            .output(
                z
                    .object({
                        id: z.string(),
                        revokedAt: z.date(),
                    })
                    .strict()
            ),
    },
};
