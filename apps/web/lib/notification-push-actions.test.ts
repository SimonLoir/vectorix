import assert from 'node:assert/strict';
import test from 'node:test';
import {
    createNotificationPushActionGate,
    disableNotificationPush,
    enableNotificationPush,
} from './notification-push-actions';
import {
    clearNotificationPushReceipt,
    readNotificationPushReceipt,
    writeNotificationPushReceipt,
    type NotificationPushReceipt,
} from './notification-push';

const receipt: NotificationPushReceipt = {
    id: 'own-registration',
    version: 3,
    deviceId: 'own-device',
};
const input = {
    expectedOrganizationId: 'own-organization',
    application: 'VECTORIX_DASHBOARD' as const,
    deviceId: receipt.deviceId,
    endpoint: 'https://push.example.test/subscription',
    expirationTime: null,
    keys: { p256dh: 'synthetic-public-key', auth: 'synthetic-auth' },
};

void test('disable revokes the exact saved receipt before local cleanup without registering', async () => {
    const calls: string[] = [];
    const result = await disableNotificationPush({
        organizationId: input.expectedOrganizationId,
        receipt,
        revoke: (value) => {
            assert.deepEqual(value, {
                id: receipt.id,
                expectedOrganizationId: input.expectedOrganizationId,
                expectedVersion: receipt.version,
            });
            calls.push('revoke');
            return Promise.resolve({});
        },
        writeReceipt: (value) => {
            assert.equal(value.serverRevoked, true);
            calls.push('persist-confirmation');
        },
        unsubscribe: () => {
            calls.push('unsubscribe');
            return Promise.resolve(true);
        },
        clearReceipt: () => {
            calls.push('clear');
        },
    });
    assert.deepEqual(calls, [
        'revoke',
        'persist-confirmation',
        'unsubscribe',
        'clear',
    ]);
    assert.equal(result.status, 'disabled');
    assert.equal(result.cleanupNeeded, false);
    assert.equal(result.receipt, null);
});

void test('unknown or stale server outcomes still attempt local cleanup and retain retry evidence', async () => {
    for (const code of [
        'NOT_FOUND',
        'FORBIDDEN',
        'BAD_REQUEST',
        'SERVICE_UNAVAILABLE',
    ]) {
        let unsubscribes = 0;
        let clears = 0;
        const result = await disableNotificationPush({
            organizationId: input.expectedOrganizationId,
            receipt,
            revoke: () =>
                Promise.reject({ code, message: 'PRIVATE_PROVIDER_DETAIL' }),
            writeReceipt: () =>
                assert.fail(
                    'An unknown revoke must not be persisted as confirmed.'
                ),
            unsubscribe: () => {
                unsubscribes++;
                return Promise.resolve(true);
            },
            clearReceipt: () => {
                clears++;
            },
        });
        assert.equal(result.status, 'serverRevokeFailed');
        assert.equal(result.serverRevoked, false);
        assert.equal(result.localRemoved, true);
        assert.deepEqual(result.receipt, receipt);
        assert.equal(result.cleanupNeeded, true);
        assert.equal(unsubscribes, 1);
        assert.equal(clears, 0);
        assert.equal(
            JSON.stringify(result).includes('PRIVATE_PROVIDER_DETAIL'),
            false
        );
    }
});

void test('false, unavailable and throwing browser cleanup remain partial after confirmed revoke', async () => {
    const cleanups = [
        () => Promise.resolve(false),
        () => Promise.resolve(null),
        () => Promise.reject(new Error('PRIVATE_BROWSER_DETAIL')),
    ];
    for (const unsubscribe of cleanups) {
        let saved: NotificationPushReceipt | null = null;
        const result = await disableNotificationPush({
            organizationId: input.expectedOrganizationId,
            receipt,
            revoke: () => Promise.resolve({}),
            unsubscribe,
            writeReceipt: (value) => {
                saved = value;
            },
            clearReceipt: () =>
                assert.fail('Partial cleanup must keep the receipt.'),
        });
        assert.equal(result.status, 'localCleanupFailed');
        assert.equal(result.serverRevoked, true);
        assert.equal(result.localRemoved, false);
        assert.equal(result.cleanupNeeded, true);
        assert.deepEqual(saved, { ...receipt, serverRevoked: true });
        const retry = await disableNotificationPush({
            organizationId: input.expectedOrganizationId,
            receipt: result.receipt,
            revoke: () => {
                assert.fail('A confirmed receipt must not be revoked twice.');
            },
            unsubscribe: () => Promise.resolve(true),
            writeReceipt: () =>
                assert.fail('The confirmation is already saved.'),
            clearReceipt: () => {},
        });
        assert.equal(retry.status, 'disabled');
    }
});

void test('local-only removal does not claim a missing server registration was revoked', async () => {
    const result = await disableNotificationPush({
        organizationId: input.expectedOrganizationId,
        receipt: null,
        revoke: () => {
            assert.fail('No server identity is available.');
        },
        unsubscribe: () => Promise.resolve(true),
        writeReceipt: () => assert.fail('No receipt should be invented.'),
        clearReceipt: () => assert.fail('No scoped receipt should be erased.'),
    });
    assert.equal(result.status, 'localOnly');
    assert.equal(result.serverRevoked, false);
    assert.equal(result.cleanupNeeded, false);
});

void test('storage failures retain confirmed server state in the action result for retry', async () => {
    const result = await disableNotificationPush({
        organizationId: input.expectedOrganizationId,
        receipt,
        revoke: () => Promise.resolve({}),
        unsubscribe: () => Promise.resolve(true),
        writeReceipt: () => {
            throw new Error('Storage unavailable');
        },
        clearReceipt: () => {
            throw new Error('Storage unavailable');
        },
    });
    assert.equal(result.status, 'receiptUnavailable');
    assert.equal(result.cleanupNeeded, true);
    assert.equal(result.receipt?.serverRevoked, true);
});

function preparation(created: boolean, unsubscribe: () => Promise<boolean>) {
    return () =>
        Promise.resolve({
            input: () => input,
            deviceId: input.deviceId,
            created,
            unsubscribe,
        });
}

void test('successful enable saves only the scoped registration identity, never subscription secrets', async () => {
    let saved: NotificationPushReceipt | null = null;
    const result = await enableNotificationPush({
        prepare: preparation(false, () => {
            assert.fail('A reused subscription must remain active.');
        }),
        register: (value) => {
            assert.deepEqual(value, input);
            return Promise.resolve({
                id: receipt.id,
                version: receipt.version,
                unexpectedProviderData: 'PRIVATE_UNUSED_FIELD',
            });
        },
        writeReceipt: (value) => {
            saved = value;
        },
    });
    assert.equal(result.status, 'enabled');
    assert.deepEqual(saved, receipt);
    assert.equal(
        JSON.stringify(result).includes('PRIVATE_UNUSED_FIELD'),
        false
    );
    assert.equal(JSON.stringify(result).includes(input.endpoint), false);
});

void test('registration refusal rolls back only a newly created subscription, with finite guidance', async () => {
    for (const created of [true, false]) {
        let unsubscribes = 0;
        const result = await enableNotificationPush({
            prepare: preparation(created, () => {
                unsubscribes++;
                return Promise.resolve(true);
            }),
            register: () =>
                Promise.reject({
                    code: 'BAD_REQUEST',
                    message: 'PRIVATE_ENDPOINT_AND_POLICY',
                }),
            writeReceipt: () =>
                assert.fail('A refused registration must not be saved.'),
        });
        assert.equal(result.status, 'registrationRefused');
        assert.equal(result.cleanupNeeded, !created);
        assert.equal(unsubscribes, created ? 1 : 0);
        assert.equal(
            JSON.stringify(result).includes('PRIVATE_ENDPOINT'),
            false
        );
    }
});

void test('failed rollback and malformed subscription preparation preserve cleanup recovery', async () => {
    const result = await enableNotificationPush({
        prepare: () =>
            Promise.resolve({
                input: () => {
                    throw new Error('PRIVATE_SUBSCRIPTION');
                },
                deviceId: input.deviceId,
                created: true,
                unsubscribe: () => Promise.resolve(false),
            }),
        register: () => {
            assert.fail('Malformed subscription must not register.');
        },
        writeReceipt: () => assert.fail('No server receipt exists.'),
    });
    assert.equal(result.status, 'enableFailed');
    assert.equal(result.cleanupNeeded, true);
});

void test('enable records confirmed registration even if receipt storage fails, without destructive rollback', async () => {
    let unsubscribes = 0;
    const result = await enableNotificationPush({
        prepare: preparation(true, () => {
            unsubscribes++;
            return Promise.resolve(true);
        }),
        register: () =>
            Promise.resolve({ id: receipt.id, version: receipt.version }),
        writeReceipt: () => {
            throw new Error('Storage unavailable');
        },
    });
    assert.equal(result.status, 'receiptUnavailable');
    assert.deepEqual(result.receipt, receipt);
    assert.equal(result.cleanupNeeded, true);
    assert.equal(unsubscribes, 0);
});

void test('unknown codes and hostile error accessors never become policy-refusal feedback', async () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'code', {
        get() {
            reads++;
            throw new Error('PRIVATE_ACCESSOR');
        },
    });
    for (const error of [
        accessor,
        { message: 'BAD_REQUEST' },
        { code: 'PRIVATE_CODE' },
        Object.setPrototypeOf({}, { code: 'BAD_REQUEST' }),
    ]) {
        const result = await enableNotificationPush({
            prepare: preparation(false, () => Promise.resolve(true)),
            register: () => Promise.reject(error),
            writeReceipt: () => assert.fail('No registration succeeded.'),
        });
        assert.equal(result.status, 'enableFailed');
    }
    assert.equal(reads, 0);
});

void test('the action gate prevents overlap through prompts and cleanup, and releases after failure', async () => {
    const gate = createNotificationPushActionGate();
    let release: (value: string) => void = () =>
        assert.fail('Action was not started.');
    const first = gate.run(
        () =>
            new Promise<string>((resolve) => {
                release = resolve;
            })
    );
    let overlaps = 0;
    const second = await gate.run(() => {
        overlaps++;
        return Promise.resolve('overlap');
    });
    assert.deepEqual(second, { started: false });
    assert.equal(overlaps, 0);
    release('complete');
    assert.deepEqual(await first, { started: true, value: 'complete' });
    await assert.rejects(
        gate.run(() => Promise.reject(new Error('Synthetic failure')))
    );
    assert.deepEqual(await gate.run(() => Promise.resolve('retry')), {
        started: true,
        value: 'retry',
    });
});

void test('actual scoped receipt storage preserves legacy receipts and other user/organization scopes', () => {
    const values = new Map<string, string>();
    const previous = Object.getOwnPropertyDescriptor(
        globalThis,
        'localStorage'
    );
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        },
    });
    try {
        writeNotificationPushReceipt('own-user', 'own-org', receipt);
        writeNotificationPushReceipt('own-user', 'other-org', receipt);
        writeNotificationPushReceipt('other-user', 'own-org', receipt);
        assert.deepEqual(
            readNotificationPushReceipt('own-user', 'own-org'),
            receipt
        );
        writeNotificationPushReceipt('own-user', 'own-org', {
            ...receipt,
            serverRevoked: true,
        });
        assert.equal(
            readNotificationPushReceipt('own-user', 'own-org')?.serverRevoked,
            true
        );
        clearNotificationPushReceipt('own-user', 'own-org');
        assert.equal(readNotificationPushReceipt('own-user', 'own-org'), null);
        assert.deepEqual(
            readNotificationPushReceipt('own-user', 'other-org'),
            receipt
        );
        assert.deepEqual(
            readNotificationPushReceipt('other-user', 'own-org'),
            receipt
        );
        writeNotificationPushReceipt('own-user', 'own-org', {
            ...receipt,
            version: Number.POSITIVE_INFINITY,
        });
        assert.equal(readNotificationPushReceipt('own-user', 'own-org'), null);
    } finally {
        if (previous)
            Object.defineProperty(globalThis, 'localStorage', previous);
        else Reflect.deleteProperty(globalThis, 'localStorage');
    }
});
