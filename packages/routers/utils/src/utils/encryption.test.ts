import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, test } from 'node:test';
import {
    credentialSecretContext,
    EncryptedDataError,
    EncryptionConfigurationError,
    EncryptionKeyUnavailableError,
    decrypt,
    encrypt,
    needsReencryption,
} from './encryption';

const first = 'a1'.repeat(32);
const second = 'b2'.repeat(32);
const saved = {
    current: process.env.ENCRYPTION_SECRET,
    previous: process.env.ENCRYPTION_PREVIOUS_SECRETS,
};

function useKeys(current: string, previous?: string) {
    process.env.ENCRYPTION_SECRET = current;
    if (previous === undefined) delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    else process.env.ENCRYPTION_PREVIOUS_SECRETS = previous;
}

/** The pre-v2 format: iv:authTag:data without key ID or associated data. */
function legacyEncrypt(plaintext: string, key: string) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(
        'aes-256-gcm',
        Buffer.from(key, 'hex'),
        iv
    );
    const data = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
    return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${data}`;
}

afterEach(() => {
    if (saved.current === undefined) delete process.env.ENCRYPTION_SECRET;
    else process.env.ENCRYPTION_SECRET = saved.current;
    if (saved.previous === undefined)
        delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    else process.env.ENCRYPTION_PREVIOUS_SECRETS = saved.previous;
});

const context = credentialSecretContext('org-1', 'cred-1', 'apiKey');

void test('v2 ciphertexts round-trip only for the same row binding', async () => {
    useKeys(first);
    const sealed = await encrypt('provider-secret', context);
    assert.match(
        sealed,
        /^v2:[0-9a-f]{16}:[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/u
    );
    assert.equal(decrypt(sealed, context), 'provider-secret');
    for (const other of [
        credentialSecretContext('org-2', 'cred-1', 'apiKey'),
        credentialSecretContext('org-1', 'cred-2', 'apiKey'),
        credentialSecretContext('org-1', 'cred-1', 'secretAccessKey'),
    ])
        assert.throws(() => decrypt(sealed, other));
    assert.equal(needsReencryption(sealed), false);
});

void test('tampered fields and unknown keys fail closed', async () => {
    useKeys(first);
    const sealed = await encrypt('provider-secret', context);
    const parts = sealed.split(':');
    const flipped = [...parts];
    flipped[4] = (parts[4]!.startsWith('0') ? '1' : '0') + parts[4]!.slice(1);
    assert.throws(() => decrypt(flipped.join(':'), context));
    useKeys(second);
    assert.throws(
        () => decrypt(sealed, context),
        EncryptionKeyUnavailableError
    );
    assert.throws(() => decrypt('not:encrypted', context), EncryptedDataError);
});

void test('legacy values still decrypt and are flagged for re-encryption', () => {
    useKeys(first);
    const legacy = legacyEncrypt('legacy-secret', first);
    assert.equal(decrypt(legacy, context), 'legacy-secret');
    assert.equal(needsReencryption(legacy), true);
});

void test('rotation keeps retired keys readable until values are re-sealed', async () => {
    useKeys(first);
    const old = await encrypt('rotating-secret', context);
    const oldLegacy = legacyEncrypt('legacy-rotating', first);
    useKeys(second, ` ${first} `);
    assert.equal(decrypt(old, context), 'rotating-secret');
    assert.equal(decrypt(oldLegacy, context), 'legacy-rotating');
    assert.equal(needsReencryption(old), true);
    const resealed = await encrypt(decrypt(old, context), context);
    assert.equal(needsReencryption(resealed), false);
    useKeys(second);
    assert.equal(decrypt(resealed, context), 'rotating-secret');
    assert.throws(() => decrypt(old, context), EncryptionKeyUnavailableError);
    process.env.ENCRYPTION_PREVIOUS_SECRETS = 'not-hex';
    assert.throws(() => decrypt(resealed, context), {
        message:
            'ENCRYPTION_PREVIOUS_SECRETS entry 1 must be 64 hex characters (32 bytes)',
    });
});

void test('noncanonical hex, truncated tags, wrong IV sizes and malformed IDs are refused before decoding', async () => {
    useKeys(first);
    const sealed = await encrypt('strict-value', context);
    const original = sealed.split(':');
    for (const [index, replacement] of [
        [1, original[1] + '0'],
        [2, original[2] + 'zz'],
        [2, original[2]!.slice(2)],
        [3, original[3]!.slice(0, 8)],
        [3, original[3] + 'zz'],
        [4, original[4] + 'g0'],
        [4, original[4] + '0'],
    ] as const) {
        const malformed = [...original];
        malformed[index] = replacement;
        assert.throws(
            () => decrypt(malformed.join(':'), context),
            EncryptedDataError
        );
        assert.throws(
            () => needsReencryption(malformed.join(':')),
            EncryptedDataError
        );
    }
    const legacy = legacyEncrypt('strict-legacy', first).split(':');
    legacy[1] = legacy[1]!.slice(0, 8);
    assert.throws(() => decrypt(legacy.join(':'), context), EncryptedDataError);
    assert.equal(decrypt(await encrypt('', context), context), '');
});

void test('keyring configuration and ambiguous legacy key absence have distinct non-corruption errors', async () => {
    useKeys(first);
    const sealed = await encrypt('available-value', context);
    const legacy = legacyEncrypt('legacy-value', first);
    useKeys(second);
    assert.throws(
        () => decrypt(sealed, context),
        EncryptionKeyUnavailableError
    );
    assert.throws(
        () => decrypt(legacy, context),
        EncryptionKeyUnavailableError
    );
    useKeys(first, 'invalid-private-key-sentinel');
    assert.throws(
        () => decrypt(sealed, context),
        (error: unknown) =>
            error instanceof EncryptionConfigurationError &&
            !error.message.includes('invalid-private-key-sentinel')
    );
    useKeys(
        first,
        Array.from({ length: 17 }, (_, index) =>
            (index + 1).toString(16).padStart(64, '0')
        ).join(',')
    );
    assert.throws(() => decrypt(sealed, context), EncryptionConfigurationError);
});
