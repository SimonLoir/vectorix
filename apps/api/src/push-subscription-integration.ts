import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { VECTORIX_API_V1 } from '@repo/api/versioning';
import { prisma } from '@repo/db';
import { decrypt } from '@routers/utils/encryption';
import { app } from './app';
import { object, stringField } from './user-locale-tests/http';
import {
    assertPushRegistrationUnchanged,
    createPushNotificationAccount,
    pushRegistrationSnapshot,
    pushSubscriptionInput,
    requirePushTestDatabase,
    type PushFixtureCleanup,
} from './push-subscription-fixtures';

type Account = Awaited<ReturnType<typeof createPushNotificationAccount>>;
type RegisterInput = ReturnType<typeof pushSubscriptionInput>;
type Transport = 'RPC' | 'REST';
const rejection = 'The push subscription endpoint is not allowed.';

/** Preserve a wire response independently of the SDK's RPC error decoding. */
function capturedClient(headers: Record<string, string>) {
    let captured: Response | undefined;
    const client: VectorixApiV1Client = createORPCClient(
        new RPCLink({
            url: 'http://localhost:3001/rpc/v1',
            headers,
            fetch: async (request) => {
                const response = await app.request(request);
                captured = response.clone();
                return response;
            },
        })
    );
    return {
        client,
        response() {
            assert.ok(captured, 'A real RPC response must be captured.');
            const response = captured;
            captured = undefined;
            return response;
        },
    };
}

function restRegister(account: Account, input: RegisterInput) {
    return app.request('/api/v1/admin/notifications/push-subscriptions', {
        method: 'PUT',
        headers: account.headers({ 'content-type': 'application/json' }),
        body: JSON.stringify(input),
    });
}

async function assertPolicyDenied(response: Response, transport: Transport) {
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('Vectorix-API-Version'), '1');
    assert.equal(
        response.headers.get('Vectorix-API-Revision'),
        String(VECTORIX_API_V1.revision)
    );
    const text = await response.text();
    assert.ok(
        Buffer.byteLength(text) <= 1024,
        'Policy refusal envelopes must remain bounded.'
    );
    const payload: unknown = JSON.parse(text);
    const expected = {
        defined: false,
        code: 'BAD_REQUEST',
        status: 400,
        message: rejection,
    };
    assert.deepEqual(
        payload,
        transport === 'RPC' ? { json: expected } : expected
    );
}

async function denyRegistration(
    account: Account,
    input: RegisterInput,
    transport: Transport
) {
    if (transport === 'REST')
        return assertPolicyDenied(
            await restRegister(account, input),
            transport
        );
    const captured = capturedClient(account.headers());
    await assert.rejects(
        captured.client.admin.notifications.pushSubscriptions.register(input),
        {
            code: 'BAD_REQUEST',
            status: 400,
            message: rejection,
        }
    );
    await assertPolicyDenied(captured.response(), transport);
}

async function register(
    account: Account,
    input: RegisterInput,
    transport: Transport
) {
    if (transport === 'RPC')
        return account.client.admin.notifications.pushSubscriptions.register(
            input
        );
    const response = await restRegister(account, input);
    assert.equal(response.status, 200);
    const value = object(await response.json());
    const version = value.version;
    assert.ok(
        typeof version === 'number' && Number.isInteger(version) && version > 0
    );
    return { id: stringField(value.id), version };
}

/** Actual production registration has no outbound provider work, even for valid cryptographic keys. */
export async function pushSubscriptionIntegrationTests(
    t: TestContext,
    fixture: PushFixtureCleanup
) {
    requirePushTestDatabase();
    assert.notEqual(
        process.env.VECTORIX_WEB_PUSH_ENABLED,
        'true',
        'Native admission tests must never enable provider delivery.'
    );
    const previousPolicy = process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
    try {
        const owner = await createPushNotificationAccount(fixture, 'owner');
        const peer = await createPushNotificationAccount(fixture, 'peer');
        const scopes = [owner.organizationId, peer.organizationId];
        // This is an owned _test membership fixture only. Native user/org creation
        // and every operation under test still run through real HTTP guards.
        await prisma.member.create({
            data: {
                id: randomUUID(),
                userId: peer.userId,
                organizationId: owner.organizationId,
                role: 'member',
                createdAt: new Date(),
            },
        });
        const run = randomUUID();
        const endpoint = `https://fcm.googleapis.com/wp/${run}/a/../b%2f%2F?token=A%2Bb&same=1&same=2`;
        let owned: { id: string; version: number } | undefined;

        await t.test(
            'native RPC and REST registration preserve the exact opaque endpoint identity for approved vendors',
            async () => {
                for (const transport of ['RPC', 'REST'] as const) {
                    for (const url of [
                        endpoint,
                        `https://web.push.apple.com/${run}/${transport}`,
                        `https://updates.push.services.mozilla.com/wpush/v1/${run}/${transport}`,
                        `https://db3.notify.windows.com/?token=${run}-${transport}`,
                    ]) {
                        const input = pushSubscriptionInput(
                            owner.organizationId,
                            url
                        );
                        const result = await register(owner, input, transport);
                        const saved =
                            await prisma.vectorixPushSubscription.findUniqueOrThrow(
                                { where: { id: result.id } }
                            );
                        assert.equal(
                            saved.organizationId,
                            owner.organizationId
                        );
                        assert.equal(
                            saved.endpointHash,
                            createHash('sha256').update(url).digest('hex')
                        );
                        assert.equal(saved.version, result.version);
                        const decrypted: unknown = JSON.parse(
                            decrypt(saved.subscriptionEncrypted)
                        );
                        const record = object(decrypted);
                        assert.ok(
                            record.endpoint === url,
                            'Stored opaque endpoint bytes must not be rewritten.'
                        );
                        assert.ok(
                            object(record.keys).p256dh === input.keys.p256dh &&
                                object(record.keys).auth === input.keys.auth,
                            'Native subscription key bytes must survive encrypted storage.'
                        );
                        if (url === endpoint) owned = result;
                    }
                }
                assert.ok(owned);
                assert.equal(
                    (await owner.client.admin.members.me({})).userId,
                    owner.userId
                );
                assert.equal(
                    (
                        await prisma.user.findUniqueOrThrow({
                            where: { id: owner.userId },
                            select: { isSuperAdmin: true },
                        })
                    ).isSuperAdmin,
                    false
                );
            }
        );

        await t.test(
            'ordinary members can register their own device but cannot claim another member endpoint',
            async () => {
                await peer.native('organization/set-active', {
                    organizationId: owner.organizationId,
                });
                const input = pushSubscriptionInput(
                    owner.organizationId,
                    `https://web.push.apple.com/${run}/member`
                );
                await register(peer, input, 'RPC');
                const before = await pushRegistrationSnapshot(scopes);
                await assert.rejects(
                    peer.client.admin.notifications.pushSubscriptions.register(
                        pushSubscriptionInput(owner.organizationId, endpoint)
                    ),
                    { code: 'CONFLICT', status: 409 }
                );
                await assertPushRegistrationUnchanged(scopes, before);
            }
        );

        await t.test(
            'arbitrary destinations and valid-URL boundary attacks are refused on both transports without writes',
            async () => {
                for (const transport of ['RPC', 'REST'] as const) {
                    for (const url of [
                        `https://unapproved.example.test/${run}`,
                        `https://127.0.0.1/${run}`,
                        `https://10.0.0.5/${run}`,
                        `https://169.254.169.254/${run}`,
                        `https://fcm.googleapis.com.attacker.test/${run}`,
                        `https://evilpush.apple.com/${run}`,
                        `https://web.push.apple.com:8443/${run}`,
                        `https://user:PRIVATE_SENTINEL@web.push.apple.com/${run}`,
                        `https://web.push.apple.com/${run}#PRIVATE_SENTINEL`,
                    ]) {
                        const before = await pushRegistrationSnapshot(scopes);
                        await denyRegistration(
                            owner,
                            pushSubscriptionInput(owner.organizationId, url),
                            transport
                        );
                        await assertPushRegistrationUnchanged(scopes, before);
                    }
                }
            }
        );

        await t.test(
            'an exact operator override replaces native defaults without changing existing subscriptions',
            async () => {
                process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS =
                    'https://trusted-push.example.test:443/';
                try {
                    for (const transport of ['RPC', 'REST'] as const) {
                        await register(
                            owner,
                            pushSubscriptionInput(
                                owner.organizationId,
                                `https://trusted-push.example.test/${run}/${transport}?opaque=%2f%2F`
                            ),
                            transport
                        );
                        for (const url of [
                            endpoint,
                            `https://sibling.trusted-push.example.test/${run}`,
                        ]) {
                            const before =
                                await pushRegistrationSnapshot(scopes);
                            await denyRegistration(
                                owner,
                                pushSubscriptionInput(
                                    owner.organizationId,
                                    url
                                ),
                                transport
                            );
                            await assertPushRegistrationUnchanged(
                                scopes,
                                before
                            );
                        }
                    }
                } finally {
                    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
                }
            }
        );

        await t.test(
            'invalid or empty operator configuration refuses admission without fallback or mass revocation',
            async () => {
                try {
                    for (const configuration of [
                        '',
                        ' , ',
                        'https://trusted-push.example.test,PRIVATE_CONFIGURATION_SENTINEL',
                    ]) {
                        process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS =
                            configuration;
                        for (const transport of ['RPC', 'REST'] as const) {
                            const before =
                                await pushRegistrationSnapshot(scopes);
                            await denyRegistration(
                                owner,
                                pushSubscriptionInput(
                                    owner.organizationId,
                                    endpoint
                                ),
                                transport
                            );
                            await assertPushRegistrationUnchanged(
                                scopes,
                                before
                            );
                        }
                    }
                } finally {
                    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
                }
            }
        );

        await t.test(
            'active-organization pinning and session-only registration still deny a valid scoped API key',
            async () => {
                const beforeMismatch = await pushRegistrationSnapshot(scopes);
                await assert.rejects(
                    owner.client.admin.notifications.pushSubscriptions.register(
                        pushSubscriptionInput(peer.organizationId, endpoint)
                    ),
                    { code: 'CONFLICT', status: 409 }
                );
                await assertPushRegistrationUnchanged(scopes, beforeMismatch);
                const key =
                    await owner.client.admin.organization.apiKeys.create({
                        name: 'Push session-only test',
                        permissions: { settings: ['read'] },
                    });
                try {
                    const captured = capturedClient({ 'x-api-key': key.key });
                    assert.equal(
                        (await captured.client.admin.organization.get({})).id,
                        owner.organizationId
                    );
                    const before = await pushRegistrationSnapshot(scopes);
                    await assert.rejects(
                        captured.client.admin.notifications.pushSubscriptions.register(
                            pushSubscriptionInput(
                                owner.organizationId,
                                endpoint
                            )
                        ),
                        { code: 'FORBIDDEN', status: 403 }
                    );
                    assert.equal(captured.response().status, 403);
                    const response = await app.request(
                        '/api/v1/admin/notifications/push-subscriptions',
                        {
                            method: 'PUT',
                            headers: {
                                'x-api-key': key.key,
                                'content-type': 'application/json',
                            },
                            body: JSON.stringify(
                                pushSubscriptionInput(
                                    owner.organizationId,
                                    endpoint
                                )
                            ),
                        }
                    );
                    assert.equal(response.status, 403);
                    await assertPushRegistrationUnchanged(scopes, before);
                } finally {
                    await owner.native('api-key/delete', {
                        keyId: key.id,
                        configId: 'org',
                    });
                }
            }
        );

        await t.test(
            'direct-ID revocation stays recipient-scoped and requires the current subscription version',
            async () => {
                assert.ok(owned);
                const target = owned;
                const revoke = {
                    id: target.id,
                    expectedOrganizationId: owner.organizationId,
                    expectedVersion: target.version,
                };
                const beforePeer = await pushRegistrationSnapshot(scopes);
                await assert.rejects(
                    peer.client.admin.notifications.pushSubscriptions.revoke(
                        revoke
                    ),
                    { code: 'NOT_FOUND', status: 404 }
                );
                await assertPushRegistrationUnchanged(scopes, beforePeer);
                await peer.native('organization/set-active', {
                    organizationId: peer.organizationId,
                });
                const beforeForeign = await pushRegistrationSnapshot(scopes);
                const foreign = await app.request(
                    `/api/v1/admin/notifications/push-subscriptions/${target.id}`,
                    {
                        method: 'DELETE',
                        headers: peer.headers({
                            'content-type': 'application/json',
                        }),
                        body: JSON.stringify({
                            expectedOrganizationId: peer.organizationId,
                            expectedVersion: target.version,
                        }),
                    }
                );
                assert.equal(foreign.status, 404);
                await assertPushRegistrationUnchanged(scopes, beforeForeign);
                const refreshed =
                    await owner.client.admin.notifications.pushSubscriptions.register(
                        pushSubscriptionInput(owner.organizationId, endpoint)
                    );
                assert.equal(refreshed.id, target.id);
                assert.equal(refreshed.version, target.version + 1);
                const beforeStale = await pushRegistrationSnapshot(scopes);
                await assert.rejects(
                    owner.client.admin.notifications.pushSubscriptions.revoke(
                        revoke
                    ),
                    { code: 'NOT_FOUND', status: 404 }
                );
                await assertPushRegistrationUnchanged(scopes, beforeStale);
                // Saved-receipt disable must remain available even after policy becomes invalid.
                process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS = '';
                try {
                    const response = await app.request(
                        `/api/v1/admin/notifications/push-subscriptions/${target.id}`,
                        {
                            method: 'DELETE',
                            headers: owner.headers({
                                'content-type': 'application/json',
                            }),
                            body: JSON.stringify({
                                expectedOrganizationId: owner.organizationId,
                                expectedVersion: refreshed.version,
                            }),
                        }
                    );
                    assert.equal(response.status, 200);
                } finally {
                    delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
                }
                assert.ok(
                    (
                        await prisma.vectorixPushSubscription.findUniqueOrThrow(
                            { where: { id: target.id } }
                        )
                    ).revokedAt
                );
            }
        );
    } finally {
        if (previousPolicy === undefined)
            delete process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS;
        else process.env.VECTORIX_WEB_PUSH_ALLOWED_ORIGINS = previousPolicy;
    }
}
