import { createHash } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import {
    VectorixNotificationPushRegisterV1Schema,
    VectorixNotificationPushRevokeV1Schema,
} from '@repo/api-contracts/v1/notifications';
import type { z } from 'zod';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { encrypt, pushSubscriptionContext } from '@routers/utils/encryption';
import { runSerializableTransaction } from '@routers/utils/transactions';
import {
    admitPushEndpoint,
    createPushEndpointPolicy,
    PushEndpointPolicyConfigurationError,
} from '@routers/utils/push-endpoint-policy';
import {
    assertExpectedOrganization,
    ensureMemberRecipient,
    getNotificationSession,
} from './notification-session';

const MAX_ACTIVE_PUSH_SUBSCRIPTIONS = 20;

/** Reject untrusted destinations before encryption or any recipient/subscription write. */
function requirePushDestination(endpoint: string): void {
    try {
        const policy = createPushEndpointPolicy(
            process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS
        );
        if (admitPushEndpoint(endpoint, policy)) return;
    } catch (error) {
        if (!(error instanceof PushEndpointPolicyConfigurationError))
            throw error;
    }
    throw new ORPCError('BAD_REQUEST', {
        message: 'The push subscription endpoint is not allowed.',
    });
}

type RegisterInput = z.infer<typeof VectorixNotificationPushRegisterV1Schema>;
type RevokeInput = z.infer<typeof VectorixNotificationPushRevokeV1Schema>;

const subscriptionSelect = {
    id: true,
    application: true,
    deviceKey: true,
    expirationTime: true,
    version: true,
    createdAt: true,
    updatedAt: true,
} as const;

function endpointHash(endpoint: string) {
    return createHash('sha256').update(endpoint).digest('hex');
}

function mapSubscription(subscription: {
    id: string;
    application: string;
    deviceKey: string;
    expirationTime: Date | null;
    version: number;
    createdAt: Date;
    updatedAt: Date;
}) {
    return {
        id: subscription.id,
        application: 'VECTORIX_DASHBOARD' as const,
        deviceId: subscription.deviceKey,
        expirationTime: subscription.expirationTime,
        version: subscription.version,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
    };
}

export async function registerPushSubscription(
    context: AuthorizedContext,
    input: RegisterInput
) {
    assertExpectedOrganization(
        context.organizationId,
        input.expectedOrganizationId
    );
    if (input.expirationTime && input.expirationTime <= new Date()) {
        throw new ORPCError('BAD_REQUEST', {
            message: 'The push subscription is already expired.',
        });
    }
    const session = await getNotificationSession(context);
    requirePushDestination(input.endpoint);
    const hash = endpointHash(input.endpoint);
    const encrypted = await encrypt(
        JSON.stringify({
            endpoint: input.endpoint,
            expirationTime: input.expirationTime?.toISOString() ?? null,
            keys: input.keys,
        }),
        pushSubscriptionContext(context.organizationId, hash)
    );

    const subscription = await runSerializableTransaction(
        context.db,
        async (tx) => {
            const recipient = await ensureMemberRecipient(tx, session);
            const endpointOwners = await tx.vectorixPushSubscription.findMany({
                where: { endpointHash: hash },
                select: {
                    recipient: {
                        select: {
                            member: { select: { userId: true } },
                        },
                    },
                },
            });
            if (
                endpointOwners.some(
                    ({ recipient: owner }) =>
                        owner.member?.userId !== session.userId
                )
            ) {
                throw new ORPCError('CONFLICT', {
                    message:
                        'This push endpoint belongs to another notification identity.',
                });
            }
            const current = await tx.vectorixPushSubscription.findUnique({
                where: {
                    ['organizationId_recipientId_application_deviceKey']: {
                        organizationId: context.organizationId,
                        recipientId: recipient.id,
                        application: input.application,
                        deviceKey: input.deviceId,
                    },
                },
                select: { id: true, version: true, revokedAt: true },
            });
            const sameEndpoint = await tx.vectorixPushSubscription.findFirst({
                where: {
                    organizationId: context.organizationId,
                    recipientId: recipient.id,
                    application: input.application,
                    endpointHash: hash,
                },
                select: { id: true, version: true, revokedAt: true },
            });
            if (current && sameEndpoint && current.id !== sameEndpoint.id)
                throwPushConflict();
            const existing = current ?? sameEndpoint;

            if (!existing) {
                const activeCount = await tx.vectorixPushSubscription.count({
                    where: {
                        organizationId: context.organizationId,
                        recipientId: recipient.id,
                        application: input.application,
                        revokedAt: null,
                    },
                });
                if (activeCount >= MAX_ACTIVE_PUSH_SUBSCRIPTIONS) {
                    throw new ORPCError('BAD_REQUEST', {
                        message: 'Too many active push subscriptions.',
                    });
                }
                return tx.vectorixPushSubscription.create({
                    data: {
                        organizationId: context.organizationId,
                        recipientId: recipient.id,
                        application: input.application,
                        deviceKey: input.deviceId,
                        endpointHash: hash,
                        subscriptionEncrypted: encrypted,
                        expirationTime: input.expirationTime,
                    },
                    select: subscriptionSelect,
                });
            }

            if (existing.revokedAt) {
                const activeCount = await tx.vectorixPushSubscription.count({
                    where: {
                        organizationId: context.organizationId,
                        recipientId: recipient.id,
                        application: input.application,
                        revokedAt: null,
                    },
                });
                if (activeCount >= MAX_ACTIVE_PUSH_SUBSCRIPTIONS) {
                    throw new ORPCError('BAD_REQUEST', {
                        message: 'Too many active push subscriptions.',
                    });
                }
            }
            const updated = await tx.vectorixPushSubscription.updateMany({
                where: {
                    id: existing.id,
                    organizationId: context.organizationId,
                    recipientId: recipient.id,
                    version: existing.version,
                },
                data: {
                    deviceKey: input.deviceId,
                    endpointHash: hash,
                    subscriptionEncrypted: encrypted,
                    expirationTime: input.expirationTime,
                    revokedAt: null,
                    version: { increment: 1 },
                },
            });
            if (updated.count !== 1) throwPushConflict();
            const result = await tx.vectorixPushSubscription.findUnique({
                where: { id: existing.id },
                select: subscriptionSelect,
            });
            if (!result) throwPushConflict();
            return result;
        }
    );
    return mapSubscription(subscription);
}

export async function revokePushSubscription(
    context: AuthorizedContext,
    input: RevokeInput
) {
    assertExpectedOrganization(
        context.organizationId,
        input.expectedOrganizationId
    );
    const session = await getNotificationSession(context);
    if (!session.recipientId) throw new ORPCError('NOT_FOUND');
    const revokedAt = new Date();
    const result = await context.db.vectorixPushSubscription.updateMany({
        where: {
            id: input.id,
            organizationId: context.organizationId,
            recipientId: session.recipientId,
            version: input.expectedVersion,
            revokedAt: null,
        },
        data: {
            revokedAt,
            version: { increment: 1 },
        },
    });
    if (result.count !== 1) throw new ORPCError('NOT_FOUND');
    return { id: input.id, revokedAt };
}

function throwPushConflict(): never {
    throw new ORPCError('CONFLICT', {
        message: 'The push subscription changed elsewhere. Reload and retry.',
    });
}
