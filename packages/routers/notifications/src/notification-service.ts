import { ORPCError } from '@orpc/server';
import {
    VectorixNotificationActionV1Schema,
    VectorixNotificationEventTypeV1Schema,
    VectorixNotificationListV1Schema,
    VectorixNotificationSourceV1Schema,
} from '@repo/api-contracts/v1/notifications';
import type { Prisma } from '@repo/db';
import type { z } from 'zod';
import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    buildNotificationAction,
    type NotificationSource,
} from '@routers/utils/notifications';
import {
    assertExpectedOrganization,
    getNotificationSession,
} from './notification-session';
import {
    visibleNotificationIds,
    type NotificationAccessRow,
} from './notification-visibility';

type ListInput = z.infer<typeof VectorixNotificationListV1Schema>;

const notificationSelect = {
    id: true,
    sequence: true,
    eventType: true,
    occurredAt: true,
    actorMemberId: true,
    title: true,
    body: true,
    sourceKind: true,
    sourceId: true,
    sourceVersion: true,
    actionKind: true,
    actionVersion: true,
    actionData: true,
    readAt: true,
    createdAt: true,
} as const satisfies Prisma.VectorixNotificationSelect;

const notificationIdentitySelect = {
    id: true,
    eventType: true,
    sourceKind: true,
    sourceId: true,
    sourceVersion: true,
    actionKind: true,
    actionVersion: true,
    actionData: true,
} as const satisfies Prisma.VectorixNotificationSelect;

type NotificationRow = Prisma.VectorixNotificationGetPayload<{
    select: typeof notificationSelect;
}>;
type NotificationIdentityRow = Prisma.VectorixNotificationGetPayload<{
    select: typeof notificationIdentitySelect;
}>;

function inboxWhere(
    organizationId: string,
    recipientId: string,
    options: {
        unreadOnly?: boolean;
        eventTypes?: readonly string[];
        sequenceLte?: number;
        sequenceLt?: number;
    } = {}
): Prisma.VectorixNotificationWhereInput {
    return {
        organizationId,
        recipientId,
        deliveries: {
            some: { channel: 'IN_APP', status: 'SENT' },
        },
        ...(options.unreadOnly ? { readAt: null } : {}),
        ...(options.eventTypes
            ? { eventType: { in: [...options.eventTypes] } }
            : {}),
        ...(options.sequenceLte === undefined &&
        options.sequenceLt === undefined
            ? {}
            : {
                  sequence: {
                      ...(options.sequenceLte === undefined
                          ? {}
                          : { lte: options.sequenceLte }),
                      ...(options.sequenceLt === undefined
                          ? {}
                          : { lt: options.sequenceLt }),
                  },
              }),
    };
}

function toAccessRow(row: NotificationRow): NotificationAccessRow {
    return {
        id: row.id,
        eventType: row.eventType,
        sourceKind: row.sourceKind,
        sourceId: row.sourceId,
        sourceVersion: row.sourceVersion,
    };
}

function validNotificationIdentity(row: NotificationIdentityRow) {
    const eventType = VectorixNotificationEventTypeV1Schema.safeParse(
        row.eventType
    );
    const source = VectorixNotificationSourceV1Schema.safeParse({
        kind: row.sourceKind,
        id: row.sourceId,
        version: row.sourceVersion,
    });
    const data =
        typeof row.actionData === 'object' &&
        row.actionData !== null &&
        !Array.isArray(row.actionData)
            ? row.actionData
            : {};
    const action = VectorixNotificationActionV1Schema.safeParse({
        ...data,
        kind: row.actionKind,
        version: row.actionVersion,
    });
    if (!eventType.success || !source.success || !action.success) return null;
    const expectedAction = buildNotificationAction(
        eventType.data,
        source.data as NotificationSource
    );
    if (
        !expectedAction ||
        JSON.stringify(action.data) !== JSON.stringify(expectedAction)
    )
        return null;
    return {
        eventType: eventType.data,
        source: source.data,
        action: expectedAction,
    };
}

function mapNotification(row: NotificationRow) {
    const identity = validNotificationIdentity(row);
    if (!identity) return null;
    return {
        id: row.id,
        sequence: row.sequence,
        eventType: identity.eventType,
        occurredAt: row.occurredAt,
        actorMemberId: row.actorMemberId,
        title: row.title,
        body: row.body,
        source: identity.source,
        action: identity.action,
        readAt: row.readAt,
        createdAt: row.createdAt,
    };
}

type MappedNotification = NonNullable<ReturnType<typeof mapNotification>>;

async function mapVisibleNotifications(
    context: AuthorizedContext,
    memberId: string,
    rows: readonly NotificationRow[]
) {
    const visible = await visibleNotificationIds(
        context,
        memberId,
        rows.map(toAccessRow)
    );
    const mapped = rows
        .filter((row) => visible.has(row.id))
        .map(mapNotification)
        .filter(
            (notification): notification is MappedNotification =>
                notification !== null
        );
    return mapped;
}

export async function listNotifications(
    context: AuthorizedContext,
    input: ListInput
) {
    const session = await getNotificationSession(context);
    if (!session.recipientId) {
        return { notifications: [], nextCursor: null, watermark: 0 };
    }
    const recipient = await context.db.vectorixNotificationRecipient.findUnique(
        {
            where: { id: session.recipientId },
            select: { lastSequence: true },
        }
    );
    if (!recipient)
        return { notifications: [], nextCursor: null, watermark: 0 };

    const member = await context.db.member.findFirst({
        where: { id: session.memberId, organizationId: context.organizationId },
        select: { id: true },
    });
    if (!member) throw new ORPCError('UNAUTHORIZED');

    const watermark = recipient.lastSequence;
    let before = Math.min(
        input.cursor?.sequence ?? watermark + 1,
        watermark + 1
    );
    const notifications: MappedNotification[] = [];
    let exhausted = false;
    const batchSize = Math.max(25, input.limit);

    while (notifications.length < input.limit && !exhausted) {
        const rows = await context.db.vectorixNotification.findMany({
            where: inboxWhere(context.organizationId, session.recipientId, {
                unreadOnly: input.unreadOnly,
                eventTypes: input.eventTypes,
                sequenceLte: watermark,
                sequenceLt: before,
            }),
            orderBy: [{ sequence: 'desc' }, { id: 'desc' }],
            take: batchSize,
            select: notificationSelect,
        });
        if (!rows.length) break;
        const visibleNotifications = await mapVisibleNotifications(
            context,
            session.memberId,
            rows
        );
        const remaining = input.limit - notifications.length;
        const selected = visibleNotifications.slice(0, remaining);
        notifications.push(...selected);
        // The query can contain more visible rows than fit on this page.
        // Continue after the last returned row, not after the whole batch.
        before =
            selected.length === remaining
                ? (selected.at(-1)?.sequence ?? 0)
                : (rows.at(-1)?.sequence ?? 0);
        exhausted = rows.length < batchSize;
    }

    return {
        notifications,
        nextCursor:
            notifications.length === input.limit
                ? { sequence: notifications.at(-1)!.sequence }
                : null,
        watermark,
    };
}

export async function notificationUnreadCount(context: AuthorizedContext) {
    const session = await getNotificationSession(context);
    if (!session.recipientId) return { count: 0, watermark: 0 };
    const recipient = await context.db.vectorixNotificationRecipient.findUnique(
        {
            where: { id: session.recipientId },
            select: { lastSequence: true },
        }
    );
    if (!recipient) return { count: 0, watermark: 0 };
    const rows = await context.db.vectorixNotification.findMany({
        where: inboxWhere(context.organizationId, session.recipientId, {
            unreadOnly: true,
            sequenceLte: recipient.lastSequence,
        }),
        select: notificationIdentitySelect,
    });
    const visible = await visibleNotificationIds(
        context,
        session.memberId,
        rows
    );
    return {
        count: rows.filter(
            (row) =>
                visible.has(row.id) && validNotificationIdentity(row) !== null
        ).length,
        watermark: recipient.lastSequence,
    };
}

export async function markNotificationRead(
    context: AuthorizedContext,
    input: { id: string; expectedOrganizationId: string }
) {
    assertExpectedOrganization(
        context.organizationId,
        input.expectedOrganizationId
    );
    const session = await getNotificationSession(context);
    if (!session.recipientId) throw new ORPCError('NOT_FOUND');
    const row = await context.db.vectorixNotification.findFirst({
        where: {
            ...inboxWhere(context.organizationId, session.recipientId),
            id: input.id,
        },
        select: notificationSelect,
    });
    if (!row) throw new ORPCError('NOT_FOUND');
    const visible = await visibleNotificationIds(context, session.memberId, [
        toAccessRow(row),
    ]);
    if (!visible.has(row.id)) throw new ORPCError('NOT_FOUND');
    const mapped = mapNotification(row);
    if (!mapped) throw new ORPCError('NOT_FOUND');
    if (row.readAt) return { id: row.id, readAt: row.readAt };
    const readAt = new Date();
    await context.db.vectorixNotification.updateMany({
        where: {
            id: row.id,
            organizationId: context.organizationId,
            recipientId: session.recipientId,
            readAt: null,
        },
        data: { readAt },
    });
    const current = await context.db.vectorixNotification.findUnique({
        where: { id: row.id },
        select: { readAt: true },
    });
    if (!current?.readAt) throw new ORPCError('NOT_FOUND');
    return { id: row.id, readAt: current.readAt };
}

export async function markAllNotificationsRead(
    context: AuthorizedContext,
    input: { expectedOrganizationId: string; watermark: number }
) {
    assertExpectedOrganization(
        context.organizationId,
        input.expectedOrganizationId
    );
    const session = await getNotificationSession(context);
    const readAt = new Date();
    if (!session.recipientId) return { watermark: 0, readAt, updatedCount: 0 };
    const recipient = await context.db.vectorixNotificationRecipient.findUnique(
        {
            where: { id: session.recipientId },
            select: { lastSequence: true },
        }
    );
    if (!recipient) throw new ORPCError('NOT_FOUND');
    const watermark = Math.min(input.watermark, recipient.lastSequence);
    const rows = await context.db.vectorixNotification.findMany({
        where: inboxWhere(context.organizationId, session.recipientId, {
            unreadOnly: true,
            sequenceLte: watermark,
        }),
        select: notificationIdentitySelect,
    });
    const visible = await visibleNotificationIds(
        context,
        session.memberId,
        rows
    );
    const validVisible = rows
        .filter(
            (row) =>
                visible.has(row.id) && validNotificationIdentity(row) !== null
        )
        .map((row) => row.id);
    const result = validVisible.length
        ? await context.db.vectorixNotification.updateMany({
              where: {
                  organizationId: context.organizationId,
                  recipientId: session.recipientId,
                  id: { in: validVisible },
                  readAt: null,
                  sequence: { lte: watermark },
              },
              data: { readAt },
          })
        : { count: 0 };
    return { watermark, readAt, updatedCount: result.count };
}
