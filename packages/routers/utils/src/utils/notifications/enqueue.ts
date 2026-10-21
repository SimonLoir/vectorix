import { createHash } from 'node:crypto';
import type { Prisma } from '@repo/db';
import { notificationEventRegistry, buildNotificationAction } from './registry';
import {
    NOTIFICATION_CHANNELS,
    type NotificationEventType,
    type NotificationSource,
    type NotificationRecipient,
} from './types';
import {
    accountSignInSourceExists,
    readAccountSignInTemplateData,
} from './account-sign-in-source';
export function makeNotificationEventKey(
    event: NotificationEventType,
    source: NotificationSource
) {
    return createHash('sha256')
        .update(JSON.stringify([event, source]))
        .digest('hex');
}
/** Atomically persist an inbox projection and durable channel receipts. Replays reuse the event key. */
export async function enqueueNotification(
    tx: Prisma.TransactionClient,
    input: {
        organizationId: string;
        eventKey: string;
        eventType: NotificationEventType;
        occurredAt: Date;
        actorMemberId: string | null;
        source: NotificationSource;
        recipients: readonly NotificationRecipient[];
        templateData: Prisma.InputJsonObject;
    }
) {
    let count = 0;
    for (const identity of input.recipients) {
        if (
            !(await accountSignInSourceExists(
                tx,
                input.organizationId,
                input.source.id,
                identity.memberId
            ))
        )
            continue;
        const member = await tx.member.findFirst({
            where: {
                id: identity.memberId,
                organizationId: input.organizationId,
            },
            include: { user: { select: { locale: true } } },
        });
        if (!member) continue;
        const recipient = await tx.vectorixNotificationRecipient.upsert({
            where: {
                ['organizationId_memberId']: {
                    organizationId: input.organizationId,
                    memberId: member.id,
                },
            },
            create: {
                organizationId: input.organizationId,
                memberOrganizationId: input.organizationId,
                memberId: member.id,
                kind: 'MEMBER',
            },
            update: {},
        });
        if (
            await tx.vectorixNotification.findUnique({
                where: {
                    ['organizationId_eventKey_recipientId']: {
                        organizationId: input.organizationId,
                        eventKey: input.eventKey,
                        recipientId: recipient.id,
                    },
                },
            })
        )
            continue;
        const preferences = await tx.vectorixNotificationPreference.findMany({
            where: {
                recipientId: recipient.id,
                organizationId: input.organizationId,
                eventType: input.eventType,
            },
        });
        const channels = NOTIFICATION_CHANNELS.filter(
            (channel) =>
                preferences.find((p) => p.channel === channel)?.enabled ??
                notificationEventRegistry[input.eventType].defaultChannels[
                    channel
                ]
        );
        if (!channels.length) continue;
        const sequence = await tx.vectorixNotificationRecipient.update({
            where: { id: recipient.id },
            data: { lastSequence: { increment: 1 } },
            select: { lastSequence: true },
        });
        const details = readAccountSignInTemplateData(input.templateData);
        const locale = member.user.locale;
        const title =
            locale === 'en'
                ? 'New sign-in to your account'
                : locale?.startsWith('nl')
                  ? 'Nieuwe aanmelding op uw account'
                  : 'Nouvelle connexion à votre compte';
        const body =
            [details?.device, details?.ipAddress, details?.signedInAt]
                .filter(Boolean)
                .join(' · ') || title;
        await tx.vectorixNotification.create({
            data: {
                organizationId: input.organizationId,
                recipientId: recipient.id,
                sequence: sequence.lastSequence,
                eventKey: input.eventKey,
                eventType: input.eventType,
                occurredAt: input.occurredAt,
                sourceKind: input.source.kind,
                sourceId: input.source.id,
                sourceVersion: input.source.version,
                title,
                body,
                actionKind: 'ACCOUNT',
                actionVersion: 1,
                actionData: buildNotificationAction(
                    input.eventType,
                    input.source
                ),
                deliveries: {
                    create: channels.map((channel) => ({
                        channel,
                        status:
                            channel === 'IN_APP'
                                ? ('SENT' as const)
                                : ('PENDING' as const),
                        sentAt: channel === 'IN_APP' ? new Date() : null,
                    })),
                },
            },
        });
        count++;
    }
    return { enqueued: count > 0, outboxId: null, recipientCount: count };
}
