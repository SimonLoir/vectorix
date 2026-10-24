import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
    isAllowedEndpoint,
    parseEndpointAllowlist,
} from '../src/endpoint-allowlist';
import { assertStorageEndpoint, StorageError } from '../src/index';

const normalize = (value: string) => new URL(value).href.replace(/\/$/, '');
const warn = console.warn;
const saved = {
    defaultEndpoint: process.env.VECTORIX_DEFAULT_S3_ENDPOINT,
    allowed: process.env.VECTORIX_S3_ALLOWED_ENDPOINTS,
};

afterEach(() => {
    console.warn = warn;
    for (const [name, value] of [
        ['VECTORIX_DEFAULT_S3_ENDPOINT', saved.defaultEndpoint],
        ['VECTORIX_S3_ALLOWED_ENDPOINTS', saved.allowed],
    ] as const)
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
});

function captureWarnings() {
    const warnings: string[] = [];
    console.warn = (message: string) => warnings.push(message);
    return warnings;
}

void test('a malformed entry does not hide later valid entries', () => {
    const warnings = captureWarnings();
    const allowed = parseEndpointAllowlist(
        'test-order',
        [
            {
                name: 'LIST',
                value: 'ollama:11434, not a url ,http://ollama-b:11434/',
                list: true,
            },
        ],
        (value) => {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol))
                throw new Error('scheme');
            return normalize(value);
        }
    );
    assert.deepEqual([...allowed], ['http://ollama-b:11434']);
    assert.equal(
        isAllowedEndpoint('http://ollama-b:11434', allowed, normalize),
        true
    );
    assert.deepEqual(warnings, [
        '[test-order] Ignoring invalid LIST entry at position 1.',
        '[test-order] Ignoring invalid LIST entry at position 2.',
    ]);
});

void test('warnings never echo the configured value and are emitted once per configuration', () => {
    const warnings = captureWarnings();
    const sources = [
        { name: 'SINGLE', value: 'secret-host-without-scheme' },
        { name: 'LIST', value: 'also-secret', list: true },
    ];
    parseEndpointAllowlist('test-once', sources, normalize);
    parseEndpointAllowlist('test-once', sources, normalize);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((message) => !message.includes('secret')));
});

void test('candidates must match exactly after normalization', () => {
    const allowed = parseEndpointAllowlist(
        'test-match',
        [{ name: 'LIST', value: 'https://s3.example.test/', list: true }],
        normalize
    );
    assert.equal(
        isAllowedEndpoint('https://s3.example.test', allowed, normalize),
        true
    );
    assert.equal(
        isAllowedEndpoint('https://other.example.test', allowed, normalize),
        false
    );
    assert.equal(isAllowedEndpoint('not a url', allowed, normalize), false);
});

void test('assertStorageEndpoint honors entries after a malformed one and follows environment changes', () => {
    captureWarnings();
    delete process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
    process.env.VECTORIX_S3_ALLOWED_ENDPOINTS =
        'rustfs:9000,http://rustfs-b:9000';
    assert.doesNotThrow(() => assertStorageEndpoint('http://rustfs-b:9000/'));
    assert.throws(
        () => assertStorageEndpoint('http://rustfs-c:9000'),
        StorageError
    );
    process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = 'http://rustfs-c:9000';
    assert.doesNotThrow(() => assertStorageEndpoint('http://rustfs-c:9000'));
    assert.throws(
        () => assertStorageEndpoint('http://rustfs-b:9000'),
        StorageError
    );
});
