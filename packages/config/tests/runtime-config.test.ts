import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
    assertRuntimeConfiguration,
    findConfigurationIssues,
    PLACEHOLDER_VALUES,
} from '../src/index';

const valid = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://vectorix@db.internal:5432/vectorix',
    BETTER_AUTH_SECRET: 'a-random-deployment-secret-with-enough-length',
    ENCRYPTION_SECRET:
        '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0',
    BETTER_AUTH_URL: 'https://api.example.test',
    TRUSTED_ORIGINS: 'https://app.example.test,https://admin.example.test',
    VECTORIX_WEB_URL: 'https://app.example.test',
};

function exampleEnvironment() {
    const values: Record<string, string> = {};
    for (const line of readFileSync(
        new URL('../../../.env.example', import.meta.url),
        'utf8'
    ).split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/u.exec(line);
        if (match) values[match[1]!] = match[2]!;
    }
    return values;
}

void test('a complete production configuration passes for both services', () => {
    assert.deepEqual(findConfigurationIssues('api', valid), []);
    assert.deepEqual(findConfigurationIssues('workers', valid), []);
    assert.deepEqual(assertRuntimeConfiguration('api', valid), []);
});

void test('.env.example placeholders cannot start production services', () => {
    const example = { ...exampleEnvironment(), NODE_ENV: 'production' };
    // Every published placeholder is still present in .env.example and recognized.
    for (const placeholder of PLACEHOLDER_VALUES)
        assert.ok(Object.values(example).includes(placeholder));
    const variables = new Set(
        findConfigurationIssues('api', example).map(({ variable }) => variable)
    );
    assert.ok(variables.has('BETTER_AUTH_SECRET'));
    assert.ok(variables.has('ENCRYPTION_SECRET'));
    assert.throws(
        () => assertRuntimeConfiguration('api', example),
        (error: Error) =>
            error.message.startsWith('Invalid api configuration') &&
            ![...PLACEHOLDER_VALUES].some((value) =>
                error.message.includes(value)
            )
    );
});

void test('malformed secrets and missing production origins are reported by name only', () => {
    const secret = 'short-secret-value';
    const issues = findConfigurationIssues('api', {
        ...valid,
        BETTER_AUTH_SECRET: secret,
        ENCRYPTION_SECRET: 'zz'.repeat(32),
        TRUSTED_ORIGINS: '',
        BETTER_AUTH_URL: 'ftp://api.example.test',
    });
    assert.deepEqual(
        issues.map(({ variable }) => variable),
        [
            'BETTER_AUTH_SECRET',
            'ENCRYPTION_SECRET',
            'BETTER_AUTH_URL',
            'TRUSTED_ORIGINS',
        ]
    );
    assert.ok(!JSON.stringify(issues).includes(secret));
    assert.deepEqual(
        findConfigurationIssues('api', {
            ...valid,
            ENCRYPTION_SECRET: '1'.repeat(64),
        }).map(({ reason }) => reason),
        ['must not repeat a single character']
    );
    assert.deepEqual(
        findConfigurationIssues('workers', {
            ...valid,
            VECTORIX_WEB_URL: undefined,
            BETTER_AUTH_SECRET: undefined,
        }).map(({ variable }) => variable),
        ['VECTORIX_WEB_URL']
    );
});

void test('outside production issues are warnings and origins are optional', () => {
    const warnings: string[] = [];
    const development = {
        ...valid,
        NODE_ENV: 'development',
        TRUSTED_ORIGINS: undefined,
        BETTER_AUTH_URL: undefined,
        BETTER_AUTH_SECRET:
            'replace-with-a-random-secret-at-least-32-characters',
    };
    const issues = assertRuntimeConfiguration('api', development, (message) =>
        warnings.push(message)
    );
    assert.deepEqual(
        issues.map(({ variable }) => variable),
        ['BETTER_AUTH_SECRET']
    );
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0]!.includes('replace-with'));
});
