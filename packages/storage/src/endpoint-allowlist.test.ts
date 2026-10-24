import assert from 'node:assert/strict';
import process from 'node:process';
import { mock, test } from 'node:test';
import {
    createEndpointAllowlist,
    type EndpointAllowlistWarning,
} from './endpoint-allowlist';
import { assertStorageEndpoint, StorageError } from './index';

const first = 'http://first.example.test:9000';
const second = 'http://second.example.test:9000';
const invalid = 'PRIVATE_OPERATOR_VALUE_NOT_A_URL';
const normalize = (value: string) => new URL(value).href.replace(/\/$/, '');

function capturePolicy() {
    const warnings: EndpointAllowlistWarning[] = [];
    const policy = createEndpointAllowlist({
        defaultVariable: 'VECTORIX_DEFAULT_S3_ENDPOINT',
        allowedVariable: 'VECTORIX_S3_ALLOWED_ENDPOINTS',
        normalize,
        warn: (warning) => warnings.push(warning),
    });
    return { policy, warnings };
}

void test('malformed entries cannot poison later approvals and every position is diagnosed', () => {
    for (const segments of [
        [invalid, first, second],
        [first, invalid, second],
        [first, second, invalid],
    ]) {
        const { policy, warnings } = capturePolicy();
        const snapshot = {
            defaultEndpoint: undefined,
            allowedEndpoints: segments.join(','),
        };
        assert.equal(policy.allows(first, snapshot), true);
        assert.equal(policy.allows(second, snapshot), true);
        assert.deepEqual(warnings, [
            {
                variable: 'VECTORIX_S3_ALLOWED_ENDPOINTS',
                index: segments.indexOf(invalid) + 1,
            },
        ]);
        assert.equal(JSON.stringify(warnings).includes(invalid), false);
    }
});

void test('a matching default does not hide malformed later CSV entries', () => {
    const { policy, warnings } = capturePolicy();
    assert.equal(
        policy.allows(first, {
            defaultEndpoint: first,
            allowedEndpoints: `${second},${invalid}`,
        }),
        true
    );
    assert.deepEqual(warnings, [
        { variable: 'VECTORIX_S3_ALLOWED_ENDPOINTS', index: 2 },
    ]);
});

void test('warnings retain original one-based CSV indexes before trimming and deduplication', () => {
    const { policy, warnings } = capturePolicy();
    assert.equal(
        policy.allows(first, {
            defaultEndpoint: invalid,
            allowedEndpoints: `, ${invalid},, ${first},${first}/, ${invalid},`,
        }),
        true
    );
    assert.deepEqual(warnings, [
        { variable: 'VECTORIX_DEFAULT_S3_ENDPOINT', index: 1 },
        { variable: 'VECTORIX_S3_ALLOWED_ENDPOINTS', index: 2 },
        { variable: 'VECTORIX_S3_ALLOWED_ENDPOINTS', index: 6 },
    ]);
    assert.ok(warnings.every((warning) => Object.isFrozen(warning)));
});

void test('empty configuration, all-invalid configuration and nonmatching destinations deny', () => {
    for (const snapshot of [
        { defaultEndpoint: undefined, allowedEndpoints: undefined },
        { defaultEndpoint: ' ', allowedEndpoints: ', ,,' },
        { defaultEndpoint: invalid, allowedEndpoints: invalid },
        { defaultEndpoint: second, allowedEndpoints: `${invalid},${second}/` },
    ]) {
        const { policy } = capturePolicy();
        assert.equal(policy.allows(first, snapshot), false);
    }
});

void test('invalid requested destinations never become operator configuration warnings', () => {
    const { policy, warnings } = capturePolicy();
    const snapshot = { defaultEndpoint: first, allowedEndpoints: undefined };
    assert.equal(policy.allows(invalid, snapshot), false);
    assert.equal(policy.allows(first, snapshot), true);
    assert.deepEqual(warnings, []);
});

void test('only the latest raw snapshot is cached and source mutation invalidates it immediately', () => {
    const warnings: EndpointAllowlistWarning[] = [];
    const normalized: string[] = [];
    const policy = createEndpointAllowlist({
        defaultVariable: 'VECTORIX_DEFAULT_S3_ENDPOINT',
        allowedVariable: 'VECTORIX_S3_ALLOWED_ENDPOINTS',
        normalize(value) {
            normalized.push(value);
            return normalize(value);
        },
        warn: (warning) => warnings.push(warning),
    });
    const snapshot = {
        defaultEndpoint: first,
        allowedEndpoints: `${invalid},${second}`,
    };
    assert.equal(policy.allows(first, snapshot), true);
    const parsed = normalized.length;
    assert.equal(policy.allows(second, { ...snapshot }), true);
    assert.equal(normalized.length, parsed + 1);
    assert.equal(warnings.length, 1);

    snapshot.defaultEndpoint = second;
    snapshot.allowedEndpoints = invalid;
    assert.equal(policy.allows(first, snapshot), false);
    assert.equal(policy.allows(second, snapshot), true);
    assert.equal(warnings.length, 2);

    // Returning to an earlier snapshot reparses it, rather than growing a history cache.
    snapshot.defaultEndpoint = first;
    snapshot.allowedEndpoints = `${invalid},${second}`;
    assert.equal(policy.allows(first, snapshot), true);
    assert.equal(warnings.length, 3);
});

void test('provider policy instances cannot reuse another provider default or cache', () => {
    const ollama = createEndpointAllowlist({
        defaultVariable: 'VECTORIX_DEFAULT_OLLAMA_ENDPOINT',
        allowedVariable: 'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS',
        normalize,
    });
    const cohere = createEndpointAllowlist({
        defaultVariable: 'VECTORIX_DEFAULT_COHERE_ENDPOINT',
        allowedVariable: 'VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS',
        normalize,
    });
    assert.equal(
        ollama.allows(first, {
            defaultEndpoint: first,
            allowedEndpoints: undefined,
        }),
        true
    );
    assert.equal(
        cohere.allows(first, {
            defaultEndpoint: second,
            allowedEndpoints: undefined,
        }),
        false
    );
    assert.equal(
        cohere.allows(first, {
            defaultEndpoint: second,
            allowedEndpoints: first,
        }),
        true
    );
});

void test('normalization remains injected and a failed diagnostic cannot change admission', () => {
    const policy = createEndpointAllowlist({
        defaultVariable: 'VECTORIX_DEFAULT_S3_ENDPOINT',
        allowedVariable: 'VECTORIX_S3_ALLOWED_ENDPOINTS',
        normalize(value) {
            if (value === invalid) throw new Error(invalid);
            return value.toUpperCase();
        },
        warn() {
            throw new Error(invalid);
        },
    });
    const snapshot = {
        defaultEndpoint: undefined,
        allowedEndpoints: `${invalid}, allowed`,
    };
    assert.equal(policy.allows('ALLOWED', snapshot), true);
    assert.equal(policy.allows('other', snapshot), false);
    assert.equal(policy.allows(invalid, snapshot), false);
});

void test('the production storage guard rereads environment and emits only fixed safe diagnostics', () => {
    const savedDefault = process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
    const savedAllowed = process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
    const warn = mock.method(console, 'warn', () => {});
    try {
        delete process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
        process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = `${invalid}, ${first}/`;
        assert.doesNotThrow(() => assertStorageEndpoint(first));
        assert.doesNotThrow(() => assertStorageEndpoint(first));
        assert.equal(warn.mock.callCount(), 1);
        assert.deepEqual(warn.mock.calls[0]?.arguments, [
            'Ignoring invalid endpoint allowlist entry.',
            { variable: 'VECTORIX_S3_ALLOWED_ENDPOINTS', index: 1 },
        ]);
        process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = second;
        assert.throws(() => assertStorageEndpoint(first), StorageError);
        process.env.VECTORIX_DEFAULT_S3_ENDPOINT = `${first}/`;
        assert.doesNotThrow(() => assertStorageEndpoint(first));
        assert.throws(() => assertStorageEndpoint(invalid), StorageError);
        assert.equal(warn.mock.callCount(), 1);
    } finally {
        if (savedDefault === undefined)
            delete process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
        else process.env.VECTORIX_DEFAULT_S3_ENDPOINT = savedDefault;
        if (savedAllowed === undefined)
            delete process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
        else process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = savedAllowed;
        warn.mock.restore();
    }
});

void test('the production storage guard keeps existing WHATWG URL and trailing-slash semantics', () => {
    const savedDefault = process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
    const savedAllowed = process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
    try {
        process.env.VECTORIX_DEFAULT_S3_ENDPOINT =
            'ftp://user:password@EXAMPLE.test:21/base?query=value#fragment';
        process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = '';
        assert.doesNotThrow(() =>
            assertStorageEndpoint(
                'ftp://user:password@example.test/base?query=value#fragment'
            )
        );
        process.env.VECTORIX_DEFAULT_S3_ENDPOINT = `${first}/base/`;
        assert.doesNotThrow(() => assertStorageEndpoint(`${first}/base`));
        assert.throws(
            () => assertStorageEndpoint(`${first}/different`),
            StorageError
        );
    } finally {
        if (savedDefault === undefined)
            delete process.env.VECTORIX_DEFAULT_S3_ENDPOINT;
        else process.env.VECTORIX_DEFAULT_S3_ENDPOINT = savedDefault;
        if (savedAllowed === undefined)
            delete process.env.VECTORIX_S3_ALLOWED_ENDPOINTS;
        else process.env.VECTORIX_S3_ALLOWED_ENDPOINTS = savedAllowed;
    }
});
