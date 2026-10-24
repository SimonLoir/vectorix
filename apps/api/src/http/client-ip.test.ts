import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VECTORIX_CLIENT_IP_HEADER } from '@repo/auth/rate-limit';
import {
    parseTrustedProxies,
    resolveClientIp,
    withClientIp,
} from './client-ip';

void test('without trusted proxies the socket peer wins and forwarded headers are ignored', () => {
    const none = parseTrustedProxies('');
    assert.equal(
        resolveClientIp('198.51.100.7', '203.0.113.1', none),
        '198.51.100.7'
    );
    assert.equal(
        resolveClientIp('::ffff:198.51.100.7', null, none),
        '198.51.100.7'
    );
    assert.equal(resolveClientIp(undefined, '203.0.113.1', none), null);
    assert.equal(resolveClientIp('not-an-ip', null, none), null);
});

void test('a trusted proxy peer is walked right to left to the first untrusted hop', () => {
    const trusted = parseTrustedProxies(
        ' 10.0.0.0/8 , 192.0.2.10,2001:db8::/32 '
    );
    // The leftmost entry is client-controlled and must never be selected past an untrusted hop.
    assert.equal(
        resolveClientIp(
            '10.1.2.3',
            '203.0.113.99, 198.51.100.7, 192.0.2.10',
            trusted
        ),
        '198.51.100.7'
    );
    assert.equal(
        resolveClientIp('2001:db8::1', '2001:db8::2, 2606:4700::1111', trusted),
        '2606:4700::1111'
    );
    assert.equal(
        resolveClientIp('10.1.2.3', '198.51.100.7, garbage', trusted),
        null
    );
    assert.equal(resolveClientIp('10.1.2.3', '10.9.9.9', trusted), null);
    assert.equal(resolveClientIp('10.1.2.3', null, trusted), null);
    // An untrusted peer cannot supply a forwarded address.
    assert.equal(
        resolveClientIp('198.51.100.8', '203.0.113.1', trusted),
        '198.51.100.8'
    );
});

void test('invalid trusted proxy entries fail by position without echoing the value', () => {
    for (const value of [
        'proxy.internal',
        '10.0.0.0/33',
        '10.0.0.0/8/1',
        '10.0.0.0/x',
    ]) {
        assert.throws(
            () => parseTrustedProxies(`192.0.2.1,${value}`),
            (error: Error) =>
                error.message ===
                    'VECTORIX_TRUSTED_PROXIES entry 2 is not an IP address or CIDR range.' &&
                !error.message.includes(value)
        );
    }
});

void test('the internal client address header is always replaced or removed', async () => {
    const spoofed = new Request('http://api.test/api/auth/sign-in/email', {
        method: 'POST',
        headers: {
            [VECTORIX_CLIENT_IP_HEADER]: '203.0.113.250',
            'content-type': 'application/json',
        },
        body: '{"ok":true}',
    });
    const replaced = withClientIp(spoofed, '198.51.100.7');
    assert.equal(
        replaced.headers.get(VECTORIX_CLIENT_IP_HEADER),
        '198.51.100.7'
    );
    assert.equal(await replaced.text(), '{"ok":true}');
    const removed = withClientIp(
        new Request('http://api.test/api/auth/get-session', {
            headers: { [VECTORIX_CLIENT_IP_HEADER]: '203.0.113.250' },
        }),
        null
    );
    assert.equal(removed.headers.has(VECTORIX_CLIENT_IP_HEADER), false);
});
