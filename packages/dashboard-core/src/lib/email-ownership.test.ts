import assert from 'node:assert/strict';
import test from 'node:test';
import {
    EMAIL_VERIFICATION_TOKEN_LIMIT,
    emailOwnershipCallback,
    emailOwnershipError,
    emailOwnershipSignInReturn,
    emailVerificationOutcome,
    emailVerificationPath,
    invitationReviewPath,
    isEmailVerificationToken,
    isInvitationId,
    requiresInvitationVerification,
} from './email-ownership';

const token = 'synthetic.proof_token-1234';
const account = '/dashboard/account';

void test('opaque invitation IDs round-trip once without becoming navigation instructions', () => {
    for (const id of [
        'ordinary-invitation',
        String.raw`invitation /+?&=%#\ é🙂`,
        '//attacker.example/path',
        '%2F%2Fattacker.example',
        'x'.repeat(128),
    ]) {
        assert.equal(isInvitationId(id), true);
        const result = invitationReviewPath(id);
        assert.ok(result);
        const url = new URL(result, 'https://web.example.test');
        assert.equal(url.origin, 'https://web.example.test');
        assert.equal(url.pathname, '/dashboard/accept-invitation');
        assert.equal(url.searchParams.get('id'), id);
        assert.equal(url.searchParams.size, 1);
        assert.equal(url.hash, '');
        assert.equal(emailOwnershipCallback(result), result);
    }
    for (const id of [
        undefined,
        null,
        123,
        ['invitation'],
        '',
        'x'.repeat(129),
        'invitation\nvalue',
        'invitation\u0000value',
        'invitation\u007Fvalue',
        '\uD800',
    ]) {
        assert.equal(isInvitationId(id), false);
    }
    assert.equal(invitationReviewPath(''), null);
});

void test('callback destinations reject external, encoded-path and authority tricks', () => {
    assert.equal(emailOwnershipCallback(account), account);
    for (const value of [
        undefined,
        null,
        [account],
        'https://attacker.example/dashboard/account',
        '//attacker.example/dashboard/account',
        String.raw`\\attacker.example`,
        String.raw`/\attacker.example/dashboard/account`,
        '/%2Fattacker.example/dashboard/account',
        '%2Fdashboard%2Faccount',
        '/dashboard/%61ccount',
        '/dashboard/account?next=https://attacker.example',
        '/dashboard/account#https://attacker.example',
        '/dashboard/account\n',
        String.raw`/dashboard/accept-invitation?id=value\evil`,
        '/dashboard/accept-invitation?id=value#fragment',
        '/dashboard/accept-invitation?id=%00',
        '/dashboard/accept-invitation?id=%0A',
        '/dashboard/accept-invitation?id=%7F',
    ]) {
        assert.equal(emailOwnershipCallback(value), null);
    }
});

void test('invitation callback query keys cannot be duplicated or extended with redirect controls', () => {
    for (const query of [
        'id=first&id=second',
        'id=first&%69d=second',
        'id=value&next=%2Fdashboard%2Faccount',
        'id=value&returnTo=%2F%2Fattacker.example',
        'id=',
        'other=value',
    ]) {
        assert.equal(
            emailOwnershipCallback(`/dashboard/accept-invitation?${query}`),
            null
        );
    }
    assert.equal(
        emailOwnershipCallback('/dashboard/accept-invitation?%69d=a%2Bb'),
        '/dashboard/accept-invitation?id=a%2Bb'
    );
});

void test('verification resume URLs preserve bounded tokens and the exact opaque invitation destination', () => {
    const callback = invitationReviewPath('opaque /+% invitation🙂');
    assert.ok(callback);
    for (const proof of ['a'.repeat(16), token, 'a'.repeat(8192)]) {
        assert.equal(isEmailVerificationToken(proof), true);
        const resume = emailVerificationPath(proof, callback);
        assert.ok(resume);
        const url = new URL(resume, 'https://web.example.test');
        assert.equal(url.origin, 'https://web.example.test');
        assert.equal(url.pathname, '/verify-email');
        assert.equal(url.searchParams.get('token'), proof);
        assert.equal(url.searchParams.get('returnTo'), callback);
        assert.equal(url.searchParams.size, 2);
        // The same boundary is used when authentication pages resume a link.
        assert.equal(emailOwnershipSignInReturn(resume), resume);
        assert.equal(
            emailOwnershipSignInReturn(emailOwnershipSignInReturn(resume)),
            resume
        );
    }
    assert.equal(EMAIL_VERIFICATION_TOKEN_LIMIT, 8192);
    for (const proof of [
        undefined,
        null,
        [token],
        '',
        'a'.repeat(15),
        'a'.repeat(8193),
        `${token}\n`,
        `${token}/`,
        `${token}?`,
        'é'.repeat(16),
    ]) {
        assert.equal(isEmailVerificationToken(proof), false);
    }
    assert.equal(emailVerificationPath('a'.repeat(15), account), null);
    assert.equal(emailVerificationPath(token, '//attacker.example'), null);
});

void test('authentication return parsing refuses duplicate, missing, oversized and encoded malicious resume inputs', () => {
    assert.equal(emailOwnershipSignInReturn(account), account);
    const valid = new URLSearchParams({ token, returnTo: account });
    for (const value of [
        undefined,
        null,
        [account],
        'https://attacker.example',
        '//attacker.example',
        String.raw`/\attacker.example`,
        `/verify-email?${valid}&token=${token}`,
        `/verify-email?${valid}&%74oken=${token}`,
        `/verify-email?${valid}&returnTo=${encodeURIComponent(account)}`,
        `/verify-email?${valid}&next=%2Fdashboard`,
        `/verify-email?token=${token}`,
        `/verify-email?returnTo=${encodeURIComponent(account)}`,
        `/verify-email?token=${token}%0A&returnTo=${encodeURIComponent(account)}`,
        `/verify-email?token=${token}&returnTo=%2F%2Fattacker.example`,
        `/verify-email?token=${token}&returnTo=%2F%5Cattacker.example`,
        `/verify-email?token=${'a'.repeat(8193)}&returnTo=${encodeURIComponent(account)}`,
        `/verify-email?${'x'.repeat(12_500)}`,
    ]) {
        assert.equal(emailOwnershipSignInReturn(value), '/dashboard');
    }
});

void test('only finite ownership codes select user-facing errors or the invitation verification branch', () => {
    const known = {
        EMAIL_VERIFICATION_UNAVAILABLE: 'unavailable',
        EMAIL_VERIFICATION_SESSION_REQUIRED: 'sessionRequired',
        EMAIL_VERIFICATION_ACCOUNT_MISMATCH: 'accountMismatch',
        EMAIL_VERIFICATION_INVALID_TOKEN: 'invalidToken',
        EMAIL_VERIFICATION_STALE: 'stale',
        EMAIL_VERIFICATION_EMAIL_MISMATCH: 'emailMismatch',
        EMAIL_VERIFICATION_REQUIRED_FOR_INVITATION: 'verificationRequired',
        EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION:
            'verificationRequired',
        YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: 'invitationRecipient',
    };
    for (const [code, key] of Object.entries(known)) {
        assert.equal(emailOwnershipError({ code }), key);
        assert.equal(
            requiresInvitationVerification({ code }),
            key === 'verificationRequired'
        );
    }
    for (const value of [
        undefined,
        null,
        'EMAIL_VERIFICATION_STALE',
        { code: 'UNREVIEWED_PROVIDER_FAILURE', message: 'private response' },
        { code: 503 },
        { status: 503 },
        {
            code: 'UNKNOWN',
            get message() {
                throw new Error('Raw messages must not be inspected.');
            },
        },
    ]) {
        assert.equal(emailOwnershipError(value), 'generic');
        assert.equal(requiresInvitationVerification(value), false);
    }
});

void test('verification outcomes require success and one of the three supported finite outcomes', () => {
    for (const outcome of [
        'ADDRESS_VERIFIED',
        'ADDRESS_CHANGED',
        'NEW_ADDRESS_VERIFICATION_REQUIRED',
    ]) {
        assert.equal(
            emailVerificationOutcome({ status: true, outcome }),
            outcome
        );
    }
    for (const value of [
        undefined,
        null,
        'ADDRESS_VERIFIED',
        { outcome: 'ADDRESS_VERIFIED' },
        { status: false, outcome: 'ADDRESS_CHANGED' },
        { status: 'true', outcome: 'ADDRESS_CHANGED' },
        { status: true, outcome: 'UNKNOWN_NATIVE_RESULT' },
        { status: true, message: 'private response body' },
    ]) {
        assert.equal(emailVerificationOutcome(value), null);
    }
});
