import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    httpRefererOrigin,
    resolveTrustedOrigins,
    serializedHttpOrigin,
    TrustedOriginsConfigurationError,
} from './trusted-origins';

void test('only absent configuration gets independent development defaults; explicit origins are exact and deduplicated', () => {
    const defaults = resolveTrustedOrigins();
    assert.deepEqual(defaults, [
        'http://localhost:3000',
        'http://localhost:3006',
    ]);
    defaults.push('https://untrusted.example');
    assert.equal(resolveTrustedOrigins().length, 2);
    assert.deepEqual(
        resolveTrustedOrigins(
            ' https://web.example.test,, https://admin.example.test:8443, https://web.example.test, '
        ),
        ['https://web.example.test', 'https://admin.example.test:8443']
    );
});

void test('empty and invalid explicit configuration fails with one fixed diagnostic instead of localhost fallback or URL disclosure', () => {
    for (const value of [
        '',
        '   ',
        ', ,',
        '*',
        'https://*.example.test',
        'https://web.example.test/',
        'https://web.example.test/path',
        'https://PRIVATE_USER:PRIVATE_SECRET@web.example.test',
        'https://@web.example.test',
        'https://web.example.test?',
        'https://web.example.test#',
        'https://web.example.test,https://evil.example/private',
    ]) {
        assert.throws(
            () => resolveTrustedOrigins(value),
            (error) => {
                assert(error instanceof TrustedOriginsConfigurationError);
                assert.equal(
                    error.message,
                    'Invalid TRUSTED_ORIGINS configuration.'
                );
                assert(!error.message.includes('PRIVATE_'));
                return true;
            }
        );
    }
});

void test('Origin accepts serialized HTTP(S) origins and refuses repaired, opaque, credentialed or combined values', () => {
    for (const origin of [
        'https://web.example.test',
        'https://admin.example.test:8443',
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://[::1]:3000',
    ])
        assert.equal(serializedHttpOrigin(origin), origin);
    for (const origin of [
        '',
        'null',
        'file://web.example.test',
        'data:text/plain,hello',
        'https://web.example.test/',
        'https://web.example.test/path',
        'https://web.example.test?',
        'https://web.example.test#',
        'https://user@web.example.test',
        'https://@web.example.test',
        'https://web.example.test:443',
        'HTTPS://WEB.EXAMPLE.TEST',
        ' https://web.example.test',
        'https://web.example.test ',
        'https://web.example.test, https://other.example.test',
        String.raw`https:\web.example.test`,
        'https:////web.example.test',
        'https://web.exa\tmple.test',
        'https://web.example.test/\n',
        'https://web.example.test/\u007F',
        'https://' + 'a'.repeat(8192),
    ])
        assert.equal(serializedHttpOrigin(origin), null, origin);
});

void test('Referer permits a full HTTP(S) path/query but rejects malformed authority, credentials, whitespace and even empty fragments', () => {
    assert.equal(
        httpRefererOrigin('https://web.example.test/dashboard?tab=documents'),
        'https://web.example.test'
    );
    assert.equal(
        httpRefererOrigin('https://admin.example.test:8443/a%20b?q=x%23y'),
        'https://admin.example.test:8443'
    );
    assert.equal(
        httpRefererOrigin('HTTPS://WEB.EXAMPLE.TEST/dashboard'),
        'https://web.example.test'
    );
    for (const referer of [
        '',
        'null',
        '/dashboard',
        'javascript:alert(1)',
        'https://user:password@web.example.test/path',
        'https://@web.example.test/path',
        'https://web.example.test/path#',
        'https://web.example.test/path#section',
        'https://web.example.test/path with spaces',
        'https://web.example.test/path, https://evil.example/',
        String.raw`https://web.example.test\@evil.example/path`,
        'https://web.example.test/path\t',
        'https://web.example.test/' + 'x'.repeat(8192),
    ])
        assert.equal(httpRefererOrigin(referer), null, referer);
});
