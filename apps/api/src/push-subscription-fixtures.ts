import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { app } from './app';
import { object, stringField } from './user-locale-tests/http';

export type PushFixtureCleanup = Readonly<{
    registerUser(id: string): void;
    registerOrganization(id: string): void;
}>;

/** Every helper is restricted to the catalog runner's isolated database. */
export function requirePushTestDatabase(): void {
    assert.ok(
        new URL(
            process.env.DATABASE_URL ?? 'postgresql://localhost/'
        ).pathname.endsWith('_test'),
        'Push integration requires the isolated test database.'
    );
}

/**
 * Create an ordinary native account and organization, retaining cookies only in
 * this closure. No fixture role, verification, session or API-key ORM write is made.
 * The core suite owns cleanup through its registered user/organization IDs.
 */
export async function createPushNotificationAccount(
    fixture: PushFixtureCleanup,
    label: string
) {
    requirePushTestDatabase();
    const run = randomUUID();
    const cookies = new Map<string, string>();
    const headers = (extra: Record<string, string> = {}) => ({
        origin: 'http://localhost:3000',
        cookie: [...cookies]
            .map(([key, value]) => `${key}=${value}`)
            .join('; '),
        ...extra,
    });
    async function native(path: string, body?: unknown): Promise<unknown> {
        const response = await app.request(
            `http://localhost:3001/api/auth/${path}`,
            {
                method: body === undefined ? 'GET' : 'POST',
                headers: headers(
                    body === undefined
                        ? {}
                        : { 'content-type': 'application/json' }
                ),
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }
        );
        for (const header of response.headers.getSetCookie()) {
            const pair = header.split(';')[0]!;
            const separator = pair.indexOf('=');
            const key = pair.slice(0, separator),
                value = pair.slice(separator + 1);
            if (value === '' || /max-age=0(?:;|$)/iu.test(header))
                cookies.delete(key);
            else cookies.set(key, value);
        }
        assert.equal(
            response.status,
            200,
            'The native push fixture request must succeed.'
        );
        const text = await response.text();
        if (text === '') return null;
        try {
            const payload: unknown = JSON.parse(text);
            return payload;
        } catch {
            throw new Error('The native push fixture response must be JSON.');
        }
    }
    const created = object(
        await native('sign-up/email', {
            name: `Push fixture ${label}`,
            email: `push-${run}@example.test`,
            password: 'Push-fixture-local-password-928!',
        })
    );
    const userId = stringField(object(created.user).id);
    fixture.registerUser(userId);
    const organizationId = stringField(
        object(
            await native('organization/create', {
                name: `Push fixture ${label}`,
                slug: `push-${run}`,
            })
        ).id
    );
    fixture.registerOrganization(organizationId);
    await native('organization/set-active', { organizationId });
    const member = await prisma.member.findFirstOrThrow({
        where: { organizationId, userId },
        select: { id: true, role: true },
    });
    assert.equal(member.role, 'owner');
    const client: VectorixApiV1Client = createORPCClient(
        new RPCLink({
            url: 'http://localhost:3001/rpc/v1',
            headers: () => headers(),
            fetch: (request) => Promise.resolve(app.request(request)),
        })
    );
    return {
        userId,
        organizationId,
        memberId: member.id,
        client,
        headers,
        native,
    };
}

/** Generate valid subscription key bytes locally; no provider registration or request occurs. */
export function pushSubscriptionInput(
    organizationId: string,
    endpoint: string,
    deviceId = randomUUID()
) {
    const ecdh = createECDH('prime256v1');
    ecdh.generateKeys();
    return {
        expectedOrganizationId: organizationId,
        application: 'VECTORIX_DASHBOARD' as const,
        deviceId,
        endpoint,
        expirationTime: null,
        keys: {
            p256dh: ecdh.getPublicKey().toString('base64url'),
            auth: randomBytes(16).toString('base64url'),
        },
    };
}

/** Capture only bounded owned rows; comparisons never dump encrypted subscription contents. */
export async function pushRegistrationSnapshot(
    organizationIds: readonly string[]
) {
    requirePushTestDatabase();
    const where = { organizationId: { in: [...organizationIds] } };
    const [
        recipients,
        subscriptions,
        audits,
        members,
        notifications,
        deliveries,
    ] = await Promise.all([
        prisma.vectorixNotificationRecipient.findMany({
            where,
            orderBy: { id: 'asc' },
            take: 101,
        }),
        prisma.vectorixPushSubscription.findMany({
            where,
            orderBy: { id: 'asc' },
            take: 101,
        }),
        prisma.ragAuditLog.findMany({
            where,
            orderBy: { id: 'asc' },
            take: 101,
        }),
        prisma.member.findMany({
            where,
            orderBy: { id: 'asc' },
            take: 101,
            select: {
                id: true,
                organizationId: true,
                userId: true,
                role: true,
            },
        }),
        prisma.vectorixNotification.findMany({
            where,
            orderBy: { id: 'asc' },
            take: 101,
            select: {
                id: true,
                organizationId: true,
                recipientId: true,
                updatedAt: true,
            },
        }),
        prisma.vectorixNotificationDelivery.findMany({
            where,
            orderBy: { id: 'asc' },
            take: 101,
            select: {
                id: true,
                organizationId: true,
                notificationId: true,
                status: true,
                attempts: true,
                leasedUntil: true,
                availableAt: true,
                updatedAt: true,
            },
        }),
    ]);
    assert.ok(
        [
            recipients,
            subscriptions,
            audits,
            members,
            notifications,
            deliveries,
        ].every((rows) => rows.length <= 100),
        'Owned push snapshots must remain bounded.'
    );
    return {
        recipients,
        subscriptions,
        audits,
        members,
        notifications,
        deliveries,
    };
}

/** Do not let assertion failures print endpoint capability URLs, ciphertext or auth keys. */
export async function assertPushRegistrationUnchanged(
    organizationIds: readonly string[],
    before: Awaited<ReturnType<typeof pushRegistrationSnapshot>>
) {
    assert.ok(
        isDeepStrictEqual(
            await pushRegistrationSnapshot(organizationIds),
            before
        ),
        'Rejected push operations must preserve subscriptions, recipients, audit rows, memberships and durable notification metadata.'
    );
}
