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

void test('encryption preflight validates the exact runtime key bytes', () => {
    for (const service of ['api', 'workers'] as const)
        for (const key of [
            ` ${valid.ENCRYPTION_SECRET}`,
            `${valid.ENCRYPTION_SECRET} `,
            `${valid.ENCRYPTION_SECRET}\n`,
            `\t${valid.ENCRYPTION_SECRET}`,
        ]) {
            const issues = findConfigurationIssues(service, {
                ...valid,
                ENCRYPTION_SECRET: key,
            });
            assert.deepEqual(
                issues.map(({ variable }) => variable),
                ['ENCRYPTION_SECRET']
            );
            assert.ok(
                !JSON.stringify(issues).includes(valid.ENCRYPTION_SECRET)
            );
        }
});

void test('deployment bases reject credentials, repaired authorities and suffixes without exposing values', () => {
    const invalid = [
        'https:private-config.example.test',
        'https:/private-config.example.test',
        'https://private-user:private-password@private-config.example.test',
        'https://private-config.example.test/?private-query',
        'https://private-config.example.test/#private-fragment',
        String.raw`https://private-config.example.test/\repaired`,
        'https://private-config.example.test/\nrepaired',
        ' https://private-config.example.test',
    ];
    for (const [service, variable] of [
        ['api', 'BETTER_AUTH_URL'],
        ['api', 'API_URL'],
        ['api', 'VECTORIX_WEB_URL'],
        ['workers', 'VECTORIX_WEB_URL'],
    ] as const)
        for (const value of invalid) {
            const issues = findConfigurationIssues(service, {
                ...valid,
                [variable]: value,
            });
            assert.deepEqual(
                issues.map(({ variable }) => variable),
                [variable]
            );
            assert.ok(!JSON.stringify(issues).includes('private-'));
        }
    assert.deepEqual(
        findConfigurationIssues('api', {
            ...valid,
            BETTER_AUTH_URL: 'https://api.example.test/auth-prefix',
            API_URL: 'https://api.example.test/api-prefix/',
            VECTORIX_WEB_URL: 'https://app.example.test/app-prefix',
        }),
        []
    );
});

void test('trusted origins are nonempty serialized origins consistent with the HTTP guard', () => {
    for (const value of [
        ',',
        ' , , ',
        'https://app.example.test/',
        'https://app.example.test/private-path',
        'https://user:password@app.example.test',
        'https://app.example.test?private-query',
        'https://app.example.test#private-fragment',
        'https:app.example.test',
        'https://app.example.test\n',
    ]) {
        const issues = findConfigurationIssues('api', {
            ...valid,
            TRUSTED_ORIGINS: value,
        });
        assert.deepEqual(
            issues.map(({ variable }) => variable),
            ['TRUSTED_ORIGINS']
        );
        assert.ok(!JSON.stringify(issues).includes('example.test'));
    }
    assert.deepEqual(
        findConfigurationIssues('api', {
            ...valid,
            TRUSTED_ORIGINS:
                ' https://app.example.test , https://admin.example.test , ',
        }),
        []
    );
});
