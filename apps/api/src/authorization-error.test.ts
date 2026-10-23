import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ORPCError, ValidationError } from '@orpc/server';
import {
    AUTHORIZATION_DENIED_MESSAGE,
    permitsOperation,
    requireOperationPermissions,
    requirePermissions,
} from '@routers/utils/permissions';
import { normalizeAuthorizationError } from '@routers/utils/authorization-error';
import {
    normalizeApiError,
    observeApiError,
} from './api-versioning/error-observation';

const sentinel = 'ISSUE14_PRIVATE_SENTINEL_NEVER_PUBLIC';
const denial = 'You do not have the required permissions.';

function capturedLogger() {
    const entries: unknown[][] = [];
    return {
        entries,
        logger: {
            error(...args: unknown[]) {
                entries.push(args);
            },
        },
    };
}

function assertGeneric(error: ORPCError<string, unknown>) {
    assert.equal(error.code, 'INTERNAL_SERVER_ERROR');
    assert.equal(error.status, 500);
    assert.equal(error.message, 'Internal server error');
    assert.equal(error.cause, undefined);
    assert.equal(error.data, undefined);
}

void test('the production permission guards use fixed English and unclassified operations fail closed', () => {
    assert.equal(AUTHORIZATION_DENIED_MESSAGE, denial);
    const context = { permissions: {}, legacyApiKey: false };
    for (const action of [
        () => requirePermissions(context, { ragGroups: ['manage'] }),
        () =>
            requireOperationPermissions(context, [
                'admin',
                'rag',
                'groups',
                'create',
            ]),
        () =>
            requireOperationPermissions(context, ['issue14', 'unknownPrivate']),
        () =>
            requireOperationPermissions({ ...context, legacyApiKey: true }, [
                'issue14',
                'unknownPrivate',
            ]),
    ]) {
        assert.throws(action, {
            code: 'FORBIDDEN',
            status: 403,
            message: denial,
        });
    }
    assert.doesNotThrow(() =>
        requirePermissions(
            { permissions: { ragGroups: ['manage'] }, legacyApiKey: false },
            { ragGroups: ['manage'] }
        )
    );
    assert.equal(
        permitsOperation({ ragGroups: ['manage'] }, 'admin.rag.groups.create'),
        true
    );
    for (const operation of ['constructor', 'toString', '__proto__']) {
        assert.equal(permitsOperation({}, operation), false);
        assert.throws(() => requireOperationPermissions(context, [operation]), {
            code: 'FORBIDDEN',
            status: 403,
            message: denial,
        });
    }
});

void test('authorization normalization preserves controlled oRPC errors and maps only native own-data UNAUTHORIZED', () => {
    const forbidden = new ORPCError('FORBIDDEN', { message: denial });
    assert.equal(normalizeAuthorizationError(forbidden), forbidden);
    const native = normalizeAuthorizationError({
        status: 'UNAUTHORIZED',
        message: sentinel,
        cause: new Error(sentinel),
    });
    assert.equal(native.code, 'UNAUTHORIZED');
    assert.equal(native.status, 401);
    assert.ok(!native.message.includes(sentinel));
    assert.equal(native.cause, undefined);
    assertGeneric(
        normalizeAuthorizationError(Object.create({ status: 'UNAUTHORIZED' }))
    );
});

void test('null, primitive and unexpected authorization errors become generic without reading status getters', () => {
    let getterCalls = 0;
    const withGetter = Object.defineProperty({}, 'status', {
        get() {
            getterCalls++;
            throw new Error(sentinel);
        },
    });
    for (const error of [
        null,
        undefined,
        true,
        27,
        27n,
        Symbol(sentinel),
        sentinel,
        new Error(sentinel, { cause: new Error(sentinel) }),
        { status: 401, privateMetadata: sentinel },
        withGetter,
    ]) {
        assertGeneric(normalizeAuthorizationError(error));
    }
    assert.equal(getterCalls, 0);
});

void test('revoked and hostile-prototype proxies cannot replace normalization or bounded observation', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostile = new Proxy(
        {},
        {
            getPrototypeOf() {
                throw new Error(sentinel);
            },
        }
    );
    for (const error of [revoked.proxy, hostile]) {
        assertGeneric(normalizeAuthorizationError(error));
        assertGeneric(normalizeApiError(error));
        const { logger, entries } = capturedLogger();
        assert.doesNotThrow(() =>
            observeApiError(error, logger, { transport: 'RPC', major: 1 })
        );
        assert.deepEqual(entries, [
            [
                { errorKind: 'UNEXPECTED', transport: 'RPC', major: 1 },
                'API request failed',
            ],
        ]);
        assert.ok(!JSON.stringify(entries).includes(sentinel));
    }
});

void test('expected client errors are unlogged and server summaries contain only fixed bounded metadata', () => {
    const { logger, entries } = capturedLogger();
    for (const code of ['FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND'] as const) {
        observeApiError(new ORPCError(code, { message: sentinel }), logger, {
            transport: 'RPC',
            major: 1,
        });
    }
    assert.equal(entries.length, 0);
    const unexpected = Object.assign(
        new Error(sentinel, { cause: new Error(sentinel) }),
        {
            metadata: { token: sentinel, providerResponse: sentinel },
        }
    );
    observeApiError(unexpected, logger, { transport: 'REST', major: 1 });
    assert.deepEqual(entries, [
        [
            { errorKind: 'UNEXPECTED', transport: 'REST', major: 1 },
            'API request failed',
        ],
    ]);
    assert.ok(!JSON.stringify(entries).includes(sentinel));
    assertGeneric(normalizeApiError(unexpected));
});

void test('output validation records a capped count without issues, data, messages or causes', () => {
    const { logger, entries } = capturedLogger();
    const error = new ORPCError('INTERNAL_SERVER_ERROR', {
        message: sentinel,
        cause: new ValidationError({
            message: sentinel,
            issues: Array.from({ length: 1105 }, () => ({
                message: sentinel,
            })),
            data: { secret: sentinel },
        }),
    });
    observeApiError(error, logger, { transport: 'RPC', major: 1 });
    assert.deepEqual(entries, [
        [
            {
                errorKind: 'OUTPUT_VALIDATION',
                transport: 'RPC',
                major: 1,
                issueCount: 1000,
            },
            'API request failed',
        ],
    ]);
    assert.ok(!JSON.stringify(entries).includes(sentinel));
    assertGeneric(normalizeApiError(error));
});

void test('controlled server errors remain compatible and logger failure cannot replace the original outcome', () => {
    const controlled = new ORPCError('SERVICE_UNAVAILABLE', {
        message: 'Controlled service unavailable.',
    });
    assert.equal(normalizeApiError(controlled), controlled);
    assert.doesNotThrow(() =>
        observeApiError(
            new Error(sentinel),
            {
                error() {
                    throw new Error(sentinel);
                },
            },
            { transport: 'RPC', major: 1 }
        )
    );
    for (const error of [null, undefined, sentinel, false, 31]) {
        assertGeneric(normalizeApiError(error));
    }
});
