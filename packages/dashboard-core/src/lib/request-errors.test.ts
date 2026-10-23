import assert from 'node:assert/strict';
import test from 'node:test';
import { requestErrorKey } from './request-errors';

void test('public authorization codes select localized outcomes without trusting messages or status', () => {
    const forbidden = Object.assign(new Error('PRIVATE_SERVER_MESSAGE'), {
        code: 'FORBIDDEN',
        status: 200,
        data: { message: 'PRIVATE_PROVIDER_BODY' },
    });
    assert.equal(requestErrorKey(forbidden), 'permission');
    assert.equal(
        requestErrorKey({ code: 'UNAUTHORIZED', message: 'PRIVATE_COOKIE' }),
        'session'
    );
    assert.equal(requestErrorKey({ status: 403 }), 'generic');
    assert.equal(requestErrorKey({ code: 'INVALID_API_KEY' }), 'generic');
});

void test('known conflicts, missing items and invalid requests retain actionable finite categories', () => {
    assert.equal(requestErrorKey({ code: 'CONFLICT' }), 'conflict');
    assert.equal(requestErrorKey({ code: 'PRECONDITION_FAILED' }), 'conflict');
    assert.equal(requestErrorKey({ code: 'NOT_FOUND' }), 'notFound');
    assert.equal(requestErrorKey({ code: 'BAD_REQUEST' }), 'invalidInput');
    assert.equal(
        requestErrorKey({ code: 'UNPROCESSABLE_CONTENT' }),
        'invalidInput'
    );
    assert.equal(requestErrorKey({ code: 'TOO_MANY_REQUESTS' }), 'rateLimited');
    assert.equal(requestErrorKey({ code: 'PAYLOAD_TOO_LARGE' }), 'tooLarge');
    assert.equal(
        requestErrorKey({ code: 'UNSUPPORTED_MEDIA_TYPE' }),
        'unsupportedFormat'
    );
});

void test('temporary transport failures preserve uncertain-outcome guidance rather than exposing details', () => {
    for (const code of [
        'TIMEOUT',
        'BAD_GATEWAY',
        'SERVICE_UNAVAILABLE',
        'GATEWAY_TIMEOUT',
    ]) {
        assert.equal(
            requestErrorKey({ code, message: 'PRIVATE_TRANSPORT_DETAIL' }),
            'unavailable'
        );
    }
    assert.equal(
        requestErrorKey({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'PRIVATE_DATABASE_QUERY',
            cause: { code: 'FORBIDDEN' },
        }),
        'generic'
    );
});

void test('unknown, malformed and nested codes never become messages or an inferred permission denial', () => {
    for (const value of [
        undefined,
        null,
        'FORBIDDEN',
        403,
        new Error('FORBIDDEN'),
        { code: null },
        { code: ['FORBIDDEN'] },
        { code: 'forbidden' },
        { code: 'PRIVATE_UNKNOWN_CODE' },
        { code: 'x'.repeat(8192) },
        Object.assign([], { code: 'FORBIDDEN' }),
        { data: { code: 'FORBIDDEN' } },
        { json: { code: 'FORBIDDEN' } },
        Object.setPrototypeOf({}, { code: 'FORBIDDEN' }),
    ]) {
        assert.equal(requestErrorKey(value), 'generic');
    }
});

void test('error rendering does not invoke accessors, proxy reads, or stringification', () => {
    let reads = 0;
    const forbidden = {};
    Object.defineProperty(forbidden, 'code', { value: 'FORBIDDEN' });
    for (const field of [
        'message',
        'name',
        'stack',
        'cause',
        'data',
        'toString',
    ]) {
        Object.defineProperty(forbidden, field, {
            get() {
                reads++;
                throw new Error('PRIVATE_ACCESSOR');
            },
        });
    }
    assert.equal(requestErrorKey(forbidden), 'permission');
    const accessor = Object.defineProperty({}, 'code', {
        get() {
            reads++;
            throw new Error('PRIVATE_CODE_ACCESSOR');
        },
    });
    assert.equal(requestErrorKey(accessor), 'generic');
    const proxy = new Proxy(
        {},
        {
            get() {
                reads++;
                throw new Error('PRIVATE_PROXY_READ');
            },
            getOwnPropertyDescriptor() {
                throw new Error('PRIVATE_PROXY_DESCRIPTOR');
            },
        }
    );
    assert.equal(requestErrorKey(proxy), 'generic');
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    assert.equal(requestErrorKey(revoked.proxy), 'generic');
    assert.equal(reads, 0);
});
