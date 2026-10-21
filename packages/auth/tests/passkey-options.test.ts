import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getPasskeyOptions } from '../src/passkey-options';

void test('keeps Better Auth defaults for local development', () => {
    assert.deepEqual(getPasskeyOptions({}), { rpName: 'Vectorix' });
});

void test('derives the RP ID from the shared cookie root domain', () => {
    assert.deepEqual(getPasskeyOptions({ ROOT_DOMAIN: '.vectorix.app' }), {
        rpName: 'Vectorix',
        rpID: 'vectorix.app',
    });
});

void test('prefers explicit passkey settings and normalizes origins', () => {
    assert.deepEqual(
        getPasskeyOptions({
            ROOT_DOMAIN: 'example.com',
            PASSKEY_RP_ID: ' vectorix.app ',
            PASSKEY_RP_NAME: 'Vectorix staging',
            PASSKEY_ORIGINS:
                'https://app.vectorix.app/, https://admin.vectorix.app,,',
        }),
        {
            rpName: 'Vectorix staging',
            rpID: 'vectorix.app',
            origin: ['https://app.vectorix.app', 'https://admin.vectorix.app'],
        }
    );
});
