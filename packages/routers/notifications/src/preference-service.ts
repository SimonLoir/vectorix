import { ORPCError } from '@orpc/server';
import {
    VectorixNotificationChannelV1Schema,
    VectorixNotificationEventTypeV1Schema,
    VectorixNotificationPreferenceUpdateV1Schema,
} from '@repo/api-contracts/v1/notifications';
import type { z } from 'zod';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { notificationEventRegistry } from '@routers/utils/notifications';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    assertExpectedOrganization,
    ensureMemberRecipient,
    getNotificationSession,
} from './notification-session';

type PreferenceUpdateInput = z.infer<
    typeof VectorixNotificationPreferenceUpdateV1Schema
>;
const eventTypes = VectorixNotificationEventTypeV1Schema.options;
const channels = VectorixNotificationChannelV1Schema.options;

async function readPreferences(
    context: AuthorizedContext,
    recipientId: string | null
) {
    const stored = recipientId
        ? await context.db.vectorixNotificationPreference.findMany({
              where: {
                  organizationId: context.organizationId,
                  recipientId,
              },
              select: {
                  eventType: true,
                  channel: true,
                  enabled: true,
                  version: true,
                  updatedAt: true,
              },
          })
        : [];
    const byKey = new Map(
        stored.map((preference) => [
            `${preference.eventType}:${preference.channel}`,
            preference,
        ])
    );
    return {
        preferences: eventTypes.flatMap((eventType) =>
            channels.map((channel) => {
                const fallback =
                    notificationEventRegistry[eventType].defaultChannels[
                        channel
                    ];
                const current = byKey.get(`${eventType}:${channel}`);
                return {
                    eventType,
                    channel,
                    enabled: current?.enabled ?? fallback,
                    defaultEnabled: fallback,
                    version: current?.version ?? null,
                    updatedAt: current?.updatedAt ?? null,
                };
            })
        ),
    };
}

export async function getNotificationPreferences(context: AuthorizedContext) {
    const session = await getNotificationSession(context);
    return readPreferences(context, session.recipientId);
}

export async function updateNotificationPreferences(
    context: AuthorizedContext,
    input: PreferenceUpdateInput
) {
    assertExpectedOrganization(
        context.organizationId,
        input.expectedOrganizationId
    );
    const session = await getNotificationSession(context);
    const recipientId = await runSerializableTransaction(
        context.db,
        async (tx) => {
            const recipient = await ensureMemberRecipient(tx, session);
            for (const change of input.changes) {
                if (change.expectedVersion === null) {
                    const result =
                        await tx.vectorixNotificationPreference.createMany({
                            data: [
                                {
                                    organizationId: context.organizationId,
                                    recipientId: recipient.id,
                                    eventType: change.eventType,
                                    channel: change.channel,
                                    enabled: change.enabled,
                                },
                            ],
                            skipDuplicates: true,
                        });
                    if (result.count !== 1) throwPreferenceConflict();
                    continue;
                }
                const result =
                    await tx.vectorixNotificationPreference.updateMany({
                        where: {
                            organizationId: context.organizationId,
                            recipientId: recipient.id,
                            eventType: change.eventType,
                            channel: change.channel,
                            version: change.expectedVersion,
                        },
                        data: {
                            enabled: change.enabled,
                            version: { increment: 1 },
                        },
                    });
                if (result.count !== 1) throwPreferenceConflict();
            }
            return recipient.id;
        }
    );
    return readPreferences(context, recipientId);
}

function throwPreferenceConflict(): never {
    throw new ORPCError('CONFLICT', {
        message:
            'Notification preferences changed elsewhere. Reload and retry.',
    });
}
