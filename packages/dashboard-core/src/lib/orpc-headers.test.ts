import assert from 'node:assert/strict';
import test from 'node:test';
import {
    VECTORIX_CSRF_HEADER,
    VECTORIX_CSRF_VALUE,
} from '@repo/api/transport-security';
import { buildSsrRpcHeaders } from './orpc-headers';

void test('SSR RPC forwards only auth and tenant pinning, replacing navigation metadata', () => {
    const incoming = new Headers({
        Cookie: 'session=synthetic-session',
        Authorization: 'Bearer synthetic-bearer',
        'x-api-key': 'synthetic-key',
        'Vectorix-Expected-Organization-Id': 'synthetic-org',
        [VECTORIX_CSRF_HEADER]: 'attacker-marker',
        Origin: 'https://attacker.example',
        Referer: 'https://attacker.example/page',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-User': '?1',
        Host: 'attacker.example',
        Forwarded: 'host=attacker.example;proto=https',
        'X-Forwarded-Host': 'attacker.example',
        'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '192.0.2.1',
        'Content-Type': 'text/html',
        'Content-Length': '1234',
        'Transfer-Encoding': 'chunked',
        'Content-Encoding': 'gzip',
        Connection: 'keep-alive',
        'Next-Action': 'synthetic-action',
        RSC: '1',
        'X-Unrecognized': 'untrusted',
    });

    assert.deepEqual(buildSsrRpcHeaders(incoming), {
        [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
        Cookie: 'session=synthetic-session',
        Authorization: 'Bearer synthetic-bearer',
        'x-api-key': 'synthetic-key',
        'Vectorix-Expected-Organization-Id': 'synthetic-org',
    });
    assert.equal(incoming.get(VECTORIX_CSRF_HEADER), 'attacker-marker');
    assert.equal(incoming.get('Origin'), 'https://attacker.example');
});

void test('SSR RPC preserves exact present auth values, including empty strings', () => {
    const values = new Map([
        ['Cookie', '  synthetic-cookie=unchanged  '],
        ['Authorization', ''],
        ['x-api-key', '  synthetic-api-key  '],
        ['Vectorix-Expected-Organization-Id', ''],
    ]);
    const requested: string[] = [];
    const outgoing = buildSsrRpcHeaders({
        get(name) {
            requested.push(name);
            assert(values.has(name), 'only explicit auth names may be read');
            return values.get(name) ?? null;
        },
    });

    assert.deepEqual(outgoing, {
        [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
        Cookie: '  synthetic-cookie=unchanged  ',
        Authorization: '',
        'x-api-key': '  synthetic-api-key  ',
        'Vectorix-Expected-Organization-Id': '',
    });
    assert.deepEqual(requested, [...values.keys()]);
});

void test('SSR RPC omits absent auth headers and always supplies its own marker', () => {
    assert.deepEqual(buildSsrRpcHeaders(new Headers()), {
        [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE,
    });
    assert.deepEqual(
        buildSsrRpcHeaders(new Headers({ [VECTORIX_CSRF_HEADER]: '' })),
        { [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE }
    );
});
