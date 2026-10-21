import assert from 'node:assert/strict';
import { test } from 'node:test';
import { app } from './app';
import { validatePermissions, permits } from '@repo/auth/permissions';
import { requireOperationPermissions } from '@routers/utils/permissions';
import {
    VectorixNotificationEventTypeV1Schema,
    VectorixNotificationActionV1Schema,
} from '@repo/api-contracts/v1/notifications';

void test('health and versioned OpenAPI only expose the core API', async () => {
    assert.equal((await app.request('/health')).status, 200);
    const result = await app.request('/spec/v1.json');
    assert.equal(result.status, 200);
    const spec = await result.json();
    assert.equal(spec.info.title, 'Vectorix API v1');
    for (const path of Object.keys(spec.paths))
        assert.match(
            path,
            /^\/(health$|admin\/(organization|members|notifications)(\/|$)|superadmin\/)/
        );
    assert.equal((await app.request('/spec.json')).status, 200);
});
void test('private and superadmin operations reject anonymous access', async () => {
    assert.equal(
        (await app.request('/api/v1/admin/organization/access')).status,
        401
    );
    assert.equal((await app.request('/api/v1/superadmin/me')).status, 401);
});
void test('explicit limited keys work and cannot delegate organization administration', () => {
    assert.deepEqual(validatePermissions({ settings: ['read'] }, true), {
        settings: ['read'],
    });
    assert.throws(() => validatePermissions({ member: ['delete'] }, true));
    assert.throws(() => validatePermissions({}, true));
    assert.throws(() => validatePermissions({ unknown: ['read'] }));
    assert.equal(
        permits({ settings: ['read'] }, { settings: ['update'] }),
        false
    );
    assert.throws(() =>
        requireOperationPermissions({ permissions: {}, legacyApiKey: false }, [
            'admin',
            'unknown',
        ])
    );
});
void test('notification payloads only accept the account event and an internal destination', () => {
    assert.deepEqual(VectorixNotificationEventTypeV1Schema.options, [
        'ACCOUNT_SIGN_IN',
    ]);
    assert.equal(
        VectorixNotificationActionV1Schema.safeParse({
            kind: 'ACCOUNT',
            version: 1,
            url: 'https://example.test',
        }).success,
        false
    );
});
