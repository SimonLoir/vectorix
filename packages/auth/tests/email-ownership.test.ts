import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmailVerificationToken } from 'better-auth/api';
import { verifyJWT } from 'better-auth/crypto';
import {
    bindEmailOwnershipToken,
    readEmailOwnershipToken,
} from '../src/email-ownership/tokens';
import {
    emailOwnershipReturnTo,
    emailOwnershipWebUrl,
} from '../src/email-ownership/configuration';

const secret = 'synthetic-email-proof-test-secret-at-least-32-bytes';
function invalidToken(error: unknown) {
    return (
        !!error &&
        typeof error === 'object' &&
        'body' in error &&
        !!error.body &&
        typeof error.body === 'object' &&
        'code' in error.body &&
        error.body.code === 'EMAIL_VERIFICATION_INVALID_TOKEN'
    );
}

void test('email proof destinations admit only canonical account and bounded invitation paths', () => {
    assert.equal(emailOwnershipReturnTo(), '/dashboard/account');
    assert.equal(
        emailOwnershipReturnTo('/dashboard/accept-invitation?id=abc_123'),
        '/dashboard/accept-invitation?id=abc_123'
    );
    for (const path of [
        '//attacker.test/x',
        '/dashboard/account?next=//attacker.test',
        '/dashboard/account#x',
        '/dashboard/accept-invitation',
        '/dashboard/accept-invitation?id=1&id=2',
        '/dashboard/accept-invitation?id=1&next=2',
        '/dashboard/accept-invitation?id=' + 'a'.repeat(129),
        '/dashboard/accept-invitation?id=%00',
        String.raw`/\attacker.test/x`,
        '/unrelated',
        'https://vectorix.invalid/dashboard/account',
    ]) {
        assert.throws(() => emailOwnershipReturnTo(path));
    }
});

void test('verification links reuse the canonical configured deployment prefix and encode proof data', () => {
    const previous = process.env.VECTORIX_WEB_URL;
    try {
        process.env.VECTORIX_WEB_URL =
            'https://configured.example.test/vectorix/';
        const url = new URL(
            emailOwnershipWebUrl(
                'proof?&=é',
                '/dashboard/accept-invitation?id=abc'
            )
        );
        assert.equal(url.origin, 'https://configured.example.test');
        assert.equal(url.pathname, '/vectorix/verify-email');
        assert.equal(url.searchParams.get('token'), 'proof?&=é');
        assert.equal(
            url.searchParams.get('returnTo'),
            '/dashboard/accept-invitation?id=abc'
        );
        process.env.VECTORIX_WEB_URL =
            'https://user:password@untrusted.example.test';
        assert.throws(() =>
            emailOwnershipWebUrl('proof', '/dashboard/account')
        );
    } finally {
        if (previous === undefined) delete process.env.VECTORIX_WEB_URL;
        else process.env.VECTORIX_WEB_URL = previous;
    }
});

void test('each native mail phase receives a signed immutable identity without extending expiry', async () => {
    for (const requestType of [
        undefined,
        'change-email-confirmation',
        'change-email-verification',
    ] as const) {
        const token = await createEmailVerificationToken(
            secret,
            'old@example.test',
            requestType ? 'new@example.test' : undefined,
            600,
            requestType ? { requestType } : undefined
        );
        const original = await verifyJWT<{ exp: number }>(token, secret);
        assert.ok(original);
        const bound = await bindEmailOwnershipToken({
            token,
            userId: 'stable-user',
            secret,
            returnTo: '/dashboard/account',
        });
        const proof = await readEmailOwnershipToken(bound.token, secret);
        assert.equal(proof.userId, 'stable-user');
        assert.equal(proof.vectorixEmailOwnership, 1);
        assert.equal(proof.email, 'old@example.test');
        assert.equal(proof.requestType, requestType);
        assert.equal(
            proof.updateTo,
            requestType ? 'new@example.test' : undefined
        );
        assert.ok(proof.exp <= original.exp);
        assert.equal(proof.returnTo, '/dashboard/account');
    }
});

void test('unbound, expired, tampered and unsupported signed proof shapes fail closed', async () => {
    const unbound = await createEmailVerificationToken(
        secret,
        'old@example.test'
    );
    await assert.rejects(
        readEmailOwnershipToken(unbound, secret),
        invalidToken
    );
    const base = {
        userId: 'stable-user',
        vectorixEmailOwnership: 1,
        returnTo: '/dashboard/account',
    };
    const expired = await createEmailVerificationToken(
        secret,
        'old@example.test',
        undefined,
        -5,
        base
    );
    await assert.rejects(
        readEmailOwnershipToken(expired, secret),
        invalidToken
    );
    const unsupported = await createEmailVerificationToken(
        secret,
        'old@example.test',
        undefined,
        600,
        { ...base, vectorixEmailOwnership: 2 }
    );
    await assert.rejects(
        readEmailOwnershipToken(unsupported, secret),
        invalidToken
    );
    const valid = await createEmailVerificationToken(
        secret,
        'old@example.test',
        undefined,
        600,
        base
    );
    const parts = valid.split('.');
    const signature = parts[2]!;
    parts[2] = (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1);
    await assert.rejects(
        readEmailOwnershipToken(parts.join('.'), secret),
        invalidToken
    );
    await assert.rejects(
        readEmailOwnershipToken('a'.repeat(8193), secret),
        invalidToken
    );
});
