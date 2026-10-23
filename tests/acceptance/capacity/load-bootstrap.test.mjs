/** Pure synthetic tests only. Run directly with node; nothing contacts HTTP, Docker, providers or a database. */
import assert from 'node:assert/strict';
import {
    DRAFT_ONLY,
    BOOTSTRAP_LIMITS,
    READER_PERMISSION,
    LoadBootstrapError,
    bootstrapLoadFixture,
    validateBootstrapConfig,
    buildLoadFixture,
    loadBootstrapCli,
    safeBootstrapError,
} from './load-bootstrap.mjs';
import {
    RUNTIME_DRAFT_ONLY,
    createBootstrapTransport,
    readBootstrapResponse,
    validateBootstrapGuardProof,
    runBootstrapRuntime,
} from './load-bootstrap-runtime.mjs';

const run = 'abc123def456';
const state = () => ({
    schemaVersion: 1,
    namespace: 'vectorix-m7c-load',
    runId: run,
    prefix: 'vectorix-m7c-load-' + run,
    phase: 'BOOTSTRAPPING',
    ports: { api: 43101, web: 43100, postgres: 45432 },
    apiOrigin: 'http://127.0.0.1:43101',
    webOrigin: 'http://127.0.0.1:43100',
    applicationDatabase: `vectorix_m7c_load_app_${run}_test`,
    environment: {
        DATABASE_URL: `postgresql://mock:mock@127.0.0.1:45432/vectorix_m7c_load_app_${run}_test`,
        BETTER_AUTH_URL: 'http://127.0.0.1:43101',
        API_URL: 'http://127.0.0.1:43101',
        VECTORIX_WEB_URL: 'http://127.0.0.1:43100',
        TRUSTED_ORIGINS: 'http://127.0.0.1:43100',
    },
});
const secret = (role) => `Mock-Private-Password-${role}-123456789!`;
const clone = (value) => structuredClone(value);
const expectCode = async (operation, code) => {
    await assert.rejects(
        operation,
        (error) => error instanceof LoadBootstrapError && error.code === code
    );
};

function mocks(options = {}) {
    let data = {
        users: [],
        organizations: [],
        members: [],
        roles: [],
        keys: 0,
        documents: 0,
        collections: 0,
        invitations: 0,
        memberGrants: 0,
        groupGrants: 0,
    };
    const checkpoints = [],
        nativeCalls = [],
        writes = [],
        dbReads = [],
        active = new Map();
    let transactions = 0,
        discarded = false,
        checkpointCalls = 0;
    const checkpoint = async (value) => {
        checkpointCalls++;
        if (options.failCheckpoint?.(clone(value), checkpointCalls))
            throw new Error('private raw checkpoint path');
        const serialized = JSON.stringify(value);
        assert(!serialized.includes('Mock-Private-Password-'));
        assert(!serialized.includes('MOCK_SESSION_TOKEN'));
        assert(!serialized.includes('cookie'));
        checkpoints.push(clone(value));
    };
    const pending = (expected) => {
        const last = checkpoints.at(-1)?.actions.at(-1);
        assert.equal(last?.action, expected);
        assert.equal(last?.status, 'PENDING');
    };
    const database = {
        async $transaction(work, settings) {
            transactions++;
            assert.equal(settings.isolationLevel, 'Serializable');
            assert.equal(settings.timeout, 10000);
            assert.equal(settings.maxWait, 5000);
            if (transactions === 2) options.beforeSynthetic?.(data);
            const saved = clone(data);
            const read = (table, maximum) => ({
                async findMany(query) {
                    assert.equal(query.take, maximum);
                    assert.deepEqual(query.orderBy, { id: 'asc' });
                    dbReads.push(table);
                    return clone(data[table].slice(0, query.take));
                },
            });
            const count = (key) => ({
                async count() {
                    dbReads.push(key);
                    return data[key];
                },
            });
            const tx = {
                user: read('users', 4),
                organization: read('organizations', 3),
                member: {
                    ...read('members', 4),
                    async create({ data: member }) {
                        pending('synthetic-reader-member-create');
                        assert.deepEqual(Object.keys(member).sort(), [
                            'createdAt',
                            'id',
                            'organizationId',
                            'role',
                            'userId',
                        ]);
                        assert(
                            member.createdAt instanceof Date &&
                                Number.isFinite(member.createdAt.getTime())
                        );
                        writes.push({
                            operation: 'member.create',
                            data: clone(member),
                        });
                        data.members.push(clone(member));
                        if (options.afterCreate)
                            return options.afterCreate(data, clone(member));
                        return clone(member);
                    },
                },
                organizationRole: read('roles', 2),
                apikey: count('keys'),
                document: count('documents'),
                collection: count('collections'),
                invitation: count('invitations'),
                collectionMemberGrant: count('memberGrants'),
                collectionGroupGrant: count('groupGrants'),
            };
            try {
                return await work(tx);
            } catch (error) {
                data = saved;
                throw error;
            }
        },
    };
    const transport = {
        async post(role, operation, body) {
            nativeCalls.push({ role, operation, body: clone(body) });
            if (options.failNative?.({ role, operation, body }, data))
                throw Object.assign(
                    new Error('RAW_CREDENTIALS_PROVIDER_RESPONSE'),
                    { status: options.failureStatus ?? 500 }
                );
            if (operation === 'sign-up/email') {
                pending('signup');
                assert.equal(body.password, secret(role));
                const user = {
                    id: 'user-' + role,
                    email: body.email,
                    isSuperAdmin: false,
                };
                data.users.push(user);
                return {
                    user: clone(user),
                    token: 'MOCK_SESSION_TOKEN',
                    headers: { cookie: 'MOCK_SESSION_TOKEN' },
                };
            }
            if (operation === 'organization/create') {
                pending('organization-create');
                const suffix = role === 'owner' ? 'A' : 'B';
                const org = { id: 'organization-' + suffix, slug: body.slug };
                data.organizations.push(org);
                data.members.push({
                    id: 'member-' + role,
                    userId: 'user-' + role,
                    organizationId: org.id,
                    role: 'owner',
                });
                return clone(org);
            }
            if (operation === 'organization/set-active') {
                pending('organization-set-active');
                active.set(role, body.organizationId);
                if (role === 'reader') options.afterReaderActive?.(data);
                return { session: { token: 'MOCK_SESSION_TOKEN' } };
            }
            if (operation === 'organization/create-role') {
                pending('reader-role-create');
                assert.deepEqual(body.permission, READER_PERMISSION);
                data.roles.push({
                    id: 'custom-reader-role',
                    organizationId: body.organizationId,
                    role: body.role,
                    permission: JSON.stringify(body.permission),
                });
                return {
                    id: 'custom-reader-role',
                    token: 'MOCK_SESSION_TOKEN',
                };
            }
            assert.fail('Forbidden native operation');
        },
        async getSession(role) {
            const user = clone(
                data.users.find((value) => value.id === 'user-' + role)
            );
            const session = {
                userId: user.id,
                activeOrganizationId: active.get(role),
                token: 'MOCK_SESSION_TOKEN',
            };
            return (
                options.session?.(role, { user, session }) ?? { user, session }
            );
        },
        discardSessions() {
            discarded = true;
            active.clear();
        },
    };
    return {
        options: {
            state: state(),
            database,
            transport,
            checkpoint,
            randomPassword: secret,
            randomId: () => 'member-reader',
            now: () => 1700000000000,
        },
        checkpoints,
        nativeCalls,
        writes,
        dbReads,
        data: () => data,
        transactions: () => transactions,
        discarded: () => discarded,
    };
}

const cases = [];
const test = (name, execute) => cases.push({ name, execute });

test('both execution entrypoints refuse invalid arguments before runtime actions', async () => {
    assert.equal(typeof DRAFT_ONLY, 'boolean');
    assert.equal(typeof RUNTIME_DRAFT_ONLY, 'boolean');
    const expected =
        DRAFT_ONLY || RUNTIME_DRAFT_ONLY
            ? 'LOAD_BOOTSTRAP_DRAFT_ONLY'
            : 'LOAD_BOOTSTRAP_ARGUMENTS';
    await expectCode(() => loadBootstrapCli([]), expected);
    await expectCode(() => runBootstrapRuntime([]), expected);
});

test('complete synthetic journey has exact fixture and one narrow database write', async () => {
    const mock = mocks();
    const fixture = await bootstrapLoadFixture(mock.options);
    assert.equal(fixture.namespace, 'vectorix-m7c-load');
    assert.equal(fixture.runId, run);
    assert.deepEqual(Object.keys(fixture).sort(), [
        'namespace',
        'organizationIds',
        'runId',
        'schemaVersion',
        'users',
    ]);
    assert.deepEqual(Object.keys(fixture.users).sort(), [
        'foreign',
        'owner',
        'reader',
    ]);
    for (const role of ['owner', 'reader', 'foreign']) {
        assert.deepEqual(Object.keys(fixture.users[role]).sort(), [
            'email',
            'memberId',
            'organizationId',
            'password',
            'userId',
        ]);
        assert.equal(fixture.users[role].password, secret(role));
    }
    assert.equal(mock.writes.length, 1);
    assert.equal(mock.writes[0].operation, 'member.create');
    assert.equal(mock.writes[0].data.userId, 'user-reader');
    assert.equal(mock.writes[0].data.organizationId, 'organization-A');
    assert.equal(mock.writes[0].data.role, 'm7c-load-reader-' + run);
    assert.equal(mock.data().users.length, 3);
    assert.equal(mock.data().organizations.length, 2);
    assert.equal(mock.data().members.length, 3);
    assert.equal(
        mock.data().users.filter((user) => user.isSuperAdmin).length,
        0
    );
    assert.equal(mock.nativeCalls.length, 9);
    assert.equal(mock.checkpoints.at(-1).status, 'VALIDATED');
    assert(
        mock.checkpoints
            .at(-1)
            .actions.every((action) => action.status === 'ACCEPTED')
    );
    assert.equal(mock.discarded(), true);
    assert(!JSON.stringify(fixture).includes('MOCK_SESSION_TOKEN'));
    assert(!JSON.stringify(fixture).includes('headers'));
    const reduced = buildLoadFixture(state(), fixture.users, {
        A: { id: 'organization-A' },
        B: { id: 'organization-B' },
    });
    assert.deepEqual(
        Object.keys(reduced.users.owner).sort(),
        Object.keys(fixture.users.owner).sort()
    );
});

test('freshness rejects any existing users and catalog artifacts before native setup', async () => {
    for (const key of [
        'users',
        'organizations',
        'members',
        'roles',
        'keys',
        'documents',
        'collections',
        'invitations',
        'memberGrants',
        'groupGrants',
    ]) {
        const mock = mocks();
        if (Array.isArray(mock.data()[key]))
            mock.data()[key].push({ id: 'existing' });
        else mock.data()[key] = 1;
        await expectCode(
            () => bootstrapLoadFixture(mock.options),
            Array.isArray(mock.data()[key])
                ? 'LOAD_BOOTSTRAP_NOT_EMPTY'
                : 'LOAD_BOOTSTRAP_EMPTY_CATALOG'
        );
        assert.equal(mock.nativeCalls.length, 0);
        assert.equal(mock.writes.length, 0);
        assert.equal(mock.checkpoints.at(-1).status, 'INCOMPLETE');
    }
});

test('any prior progress including empty journal refuses automatic replay', async () => {
    for (const priorJournal of [
        {},
        { status: 'BOOTSTRAPPING', actions: [] },
        { status: 'INCOMPLETE' },
        { status: 'VALIDATED' },
        false,
        [],
    ]) {
        const mock = mocks();
        await expectCode(
            () => bootstrapLoadFixture({ ...mock.options, priorJournal }),
            'LOAD_BOOTSTRAP_PRIOR_PROGRESS'
        );
        assert.equal(mock.transactions(), 0);
        assert.equal(mock.nativeCalls.length, 0);
        assert.equal(mock.checkpoints.length, 0);
    }
});

test('origins database namespace and native role restrictions are exact', async () => {
    const mutations = [
        (s) => {
            s.webOrigin = 'http://localhost:43100';
        },
        (s) => {
            s.apiOrigin = 'http://127.0.0.2:43101';
        },
        (s) => {
            s.environment.TRUSTED_ORIGINS += ',http://localhost:43100';
        },
        (s) => {
            s.environment.API_URL = 'http://localhost:43101';
        },
        (s) => {
            s.environment.DATABASE_URL += '?schema=public';
        },
        (s) => {
            s.environment.DATABASE_URL = s.environment.DATABASE_URL.replace(
                '45432',
                '5432'
            );
        },
        (s) => {
            s.phase = 'READY_FOR_LOAD_IMPORT';
        },
        (s) => {
            s.ports.web = s.ports.api;
        },
        (s) => {
            s.runId = 'ABC123DEF456';
        },
    ];
    for (const mutate of mutations) {
        const candidate = state();
        mutate(candidate);
        assert.throws(() => validateBootstrapConfig(candidate), {
            code: 'LOAD_BOOTSTRAP_CONFIG',
        });
    }
    const candidate = state();
    candidate.phase = 'SCHEMA_VERIFIED_EMPTY';
    validateBootstrapConfig(candidate);
});

test('passwords must be private distinct values before any side effect', async () => {
    for (const randomPassword of [
        () => 'short',
        () => 'x'.repeat(201),
        () => 'same-password-for-all-roles',
        () => 'private password with spaces',
        () => null,
    ]) {
        const mock = mocks();
        await expectCode(
            () => bootstrapLoadFixture({ ...mock.options, randomPassword }),
            'LOAD_BOOTSTRAP_PASSWORD'
        );
        assert.equal(mock.nativeCalls.length, 0);
        assert.equal(mock.checkpoints.length, 0);
    }
});

test('membership transaction rechecks all exact identities and owners before its only write', async () => {
    const drift = [
        {
            code: 'LOAD_BOOTSTRAP_IDENTITIES',
            mutate: (d) => {
                d.users[0].email = 'foreign@example.test';
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_IDENTITIES',
            mutate: (d) => {
                d.users[0].isSuperAdmin = true;
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_IDENTITIES',
            mutate: (d) => {
                d.users.push({ id: 'extra' });
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_ORGANIZATIONS',
            mutate: (d) => {
                d.organizations[1].slug = 'foreign';
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_MEMBERSHIPS',
            mutate: (d) => {
                d.members[0].role = 'admin';
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_MEMBERSHIPS',
            mutate: (d) => {
                d.members[1].organizationId = 'organization-A';
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_MEMBERSHIPS',
            mutate: (d) => {
                d.members.push({
                    id: 'reader-existing',
                    userId: 'user-reader',
                    organizationId: 'organization-B',
                    role: 'member',
                });
            },
        },
        {
            code: 'LOAD_BOOTSTRAP_EMPTY_CATALOG',
            mutate: (d) => {
                d.keys = 1;
            },
        },
    ];
    for (const item of drift) {
        const mock = mocks({ beforeSynthetic: item.mutate });
        await expectCode(() => bootstrapLoadFixture(mock.options), item.code);
        assert.equal(mock.writes.length, 0);
        assert.equal(mock.checkpoints.at(-1).status, 'INCOMPLETE');
        assert.equal(mock.discarded(), true);
    }
});

test('saved reader role rejects readAll manageAll extra actions wrong org and malformed JSON', async () => {
    const variants = [
        JSON.stringify({
            ...READER_PERMISSION,
            ragLibrary: ['read', 'readAll'],
        }),
        JSON.stringify({
            ...READER_PERMISSION,
            ragCollection: ['read', 'manageAll'],
        }),
        JSON.stringify({ ...READER_PERMISSION, dashboard: ['read', 'write'] }),
        JSON.stringify({ ...READER_PERMISSION, organization: ['update'] }),
        JSON.stringify({ dashboard: ['read'], ragLibrary: ['read'] }),
        '{private malformed json',
        JSON.stringify(READER_PERMISSION).repeat(100),
    ];
    for (const permission of variants) {
        const mock = mocks({
            beforeSynthetic(d) {
                d.roles[0].permission = permission;
            },
        });
        await expectCode(
            () => bootstrapLoadFixture(mock.options),
            'LOAD_BOOTSTRAP_READER_ROLE'
        );
        assert.equal(mock.writes.length, 0);
    }
    const mock = mocks({
        beforeSynthetic(d) {
            d.roles[0].organizationId = 'organization-B';
        },
    });
    await expectCode(
        () => bootstrapLoadFixture(mock.options),
        'LOAD_BOOTSTRAP_READER_ROLE'
    );
    assert.equal(mock.writes.length, 0);
});

test('invalid created tuple rolls back and preserves uncertain action evidence', async () => {
    const mock = mocks({
        afterCreate: (_d, member) => ({
            ...member,
            organizationId: 'organization-B',
        }),
    });
    await expectCode(
        () => bootstrapLoadFixture(mock.options),
        'LOAD_BOOTSTRAP_MEMBER_CREATE'
    );
    assert.equal(mock.data().members.length, 2);
    assert.equal(
        mock.checkpoints.at(-1).actions.at(-1).status,
        'FAILED_OR_UNCERTAIN'
    );
});

test('post-membership current session identity and final database drift both refuse fixture', async () => {
    const sessionMock = mocks({
        session: (role, result) =>
            role === 'reader'
                ? {
                      ...result,
                      session: {
                          ...result.session,
                          activeOrganizationId: 'organization-B',
                      },
                  }
                : result,
    });
    await expectCode(
        () => bootstrapLoadFixture(sessionMock.options),
        'LOAD_BOOTSTRAP_NATIVE_SESSION'
    );
    assert.equal(sessionMock.checkpoints.at(-1).status, 'INCOMPLETE');
    const finalMock = mocks({
        afterReaderActive(d) {
            d.documents = 1;
        },
    });
    await expectCode(
        () => bootstrapLoadFixture(finalMock.options),
        'LOAD_BOOTSTRAP_EMPTY_CATALOG'
    );
    assert.equal(finalMock.checkpoints.at(-1).status, 'INCOMPLETE');
});

test('native failure is finite and never retries an irreversible action', async () => {
    for (const status of [500, 429]) {
        const mock = mocks({
            failNative: ({ operation }) => operation === 'sign-up/email',
            failureStatus: status,
        });
        await expectCode(
            () => bootstrapLoadFixture(mock.options),
            status === 429
                ? 'LOAD_BOOTSTRAP_RATE_LIMITED'
                : 'LOAD_BOOTSTRAP_TRANSPORT_FAILED'
        );
        assert.equal(mock.nativeCalls.length, 1);
        assert.equal(
            mock.checkpoints.at(-1).actions.at(-1).status,
            'FAILED_OR_UNCERTAIN'
        );
        assert(
            !JSON.stringify(mock.checkpoints).includes(
                'RAW_CREDENTIALS_PROVIDER_RESPONSE'
            )
        );
        assert.equal(mock.discarded(), true);
    }
    assert.equal(
        safeBootstrapError(new Error('RAW_CREDENTIALS_PROVIDER_RESPONSE')),
        'LOAD_BOOTSTRAP_RUNTIME_FAILED'
    );
});

test('checkpoint rejection before admission performs no native mutation', async () => {
    const mock = mocks({ failCheckpoint: (_value, count) => count === 2 });
    await expectCode(
        () => bootstrapLoadFixture(mock.options),
        'LOAD_BOOTSTRAP_CHECKPOINT_FAILED'
    );
    assert.equal(mock.nativeCalls.length, 0);
    assert.equal(mock.writes.length, 0);
});

test('checkpoint rejection after accepted signup forbids admission of next signup', async () => {
    const mock = mocks({ failCheckpoint: (_value, count) => count === 3 });
    await expectCode(
        () => bootstrapLoadFixture(mock.options),
        'LOAD_BOOTSTRAP_CHECKPOINT_FAILED'
    );
    assert.equal(mock.nativeCalls.length, 1);
    assert.equal(mock.data().users.length, 1);
    assert.equal(mock.checkpoints.at(-1).status, 'INCOMPLETE');
});

test('checkpoint rejection after committed membership prevents any next native mutation', async () => {
    const mock = mocks({
        failCheckpoint: (value) =>
            value.actions.at(-1)?.action === 'synthetic-reader-member-create' &&
            value.actions.at(-1)?.status === 'ACCEPTED',
    });
    await expectCode(
        () => bootstrapLoadFixture(mock.options),
        'LOAD_BOOTSTRAP_CHECKPOINT_FAILED'
    );
    assert.equal(mock.writes.length, 1);
    assert.equal(mock.data().members.length, 3);
    assert.equal(
        mock.nativeCalls.filter(
            (call) =>
                call.role === 'reader' &&
                call.operation === 'organization/set-active'
        ).length,
        0
    );
    assert.equal(mock.checkpoints.at(-1).status, 'INCOMPLETE');
});

test('duplicate member IDs session cleanup failures and exhausted time all fail closed', async () => {
    const duplicate = mocks();
    await expectCode(
        () =>
            bootstrapLoadFixture({
                ...duplicate.options,
                randomId: () => 'member-owner',
            }),
        'LOAD_BOOTSTRAP_MEMBER_CREATE'
    );
    assert.equal(duplicate.writes.length, 0);
    const cleanup = mocks();
    cleanup.options.transport.discardSessions = () => {
        throw new Error('RAW_COOKIE');
    };
    await expectCode(
        () => bootstrapLoadFixture(cleanup.options),
        'LOAD_BOOTSTRAP_SESSION_DISCARD_FAILED'
    );
    assert.equal(cleanup.checkpoints.at(-1).status, 'INCOMPLETE');
    assert(!JSON.stringify(cleanup.checkpoints).includes('RAW_COOKIE'));
    const timed = mocks();
    let timeCalls = 0;
    await expectCode(
        () =>
            bootstrapLoadFixture({
                ...timed.options,
                now: () =>
                    ++timeCalls === 1
                        ? 1000
                        : 1000 + BOOTSTRAP_LIMITS.durationMs + 1,
            }),
        'LOAD_BOOTSTRAP_TIME_BUDGET'
    );
    assert.equal(timed.nativeCalls.length, 0);
    const password = mocks();
    await expectCode(
        () =>
            bootstrapLoadFixture({
                ...password.options,
                randomPassword: () => {
                    throw new Error('RAW_PASSWORD');
                },
            }),
        'LOAD_BOOTSTRAP_PASSWORD'
    );
});

test('fixed guard proof rejects extra caller booleans and wrong run or freshness', async () => {
    const proof = {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-load',
        runId: run,
        purpose: 'bootstrap',
        resourceOwnership: true,
        databaseReadOnly: true,
        bootstrapFreshness: true,
    };
    validateBootstrapGuardProof(proof, run);
    for (const value of [
        { ...proof, runId: '111111111111' },
        { ...proof, bootstrapFreshness: false },
        { ...proof, purpose: 'collect' },
        { ...proof, callerApproved: true },
        {},
    ])
        assert.throws(() => validateBootstrapGuardProof(value, run), {
            code: 'LOAD_BOOTSTRAP_GUARD_REFUSED',
        });
});

test('response decoding counts actual streamed bytes and cancels oversized bodies', async () => {
    let cancelled = false;
    const response = new Response(
        new ReadableStream({
            start(controller) {
                controller.enqueue(
                    new Uint8Array(BOOTSTRAP_LIMITS.responseBytes)
                );
                controller.enqueue(new Uint8Array(1));
            },
            cancel() {
                cancelled = true;
            },
        }),
        { headers: { 'content-length': '1' } }
    );
    await expectCode(
        () => readBootstrapResponse(response),
        'LOAD_BOOTSTRAP_HTTP_CAP'
    );
    assert.equal(cancelled, true);
    await expectCode(
        () =>
            readBootstrapResponse(
                new Response('{}', {
                    headers: {
                        'content-length': String(
                            BOOTSTRAP_LIMITS.responseBytes + 1
                        ),
                    },
                })
            ),
        'LOAD_BOOTSTRAP_HTTP_CAP'
    );
    await expectCode(
        () =>
            readBootstrapResponse(
                new Response('{}', { headers: { 'content-length': 'invalid' } })
            ),
        'LOAD_BOOTSTRAP_HTTP_CAP'
    );
});

test('never-settling and rejecting cancellation cannot delay a finite body refusal', async () => {
    for (const beforeRead of [false, true])
        for (const rejecting of [false, true]) {
            let cancelled = false;
            const response = new Response(
                new ReadableStream({
                    start(controller) {
                        controller.enqueue(
                            new Uint8Array(BOOTSTRAP_LIMITS.responseBytes + 1)
                        );
                    },
                    cancel() {
                        cancelled = true;
                        return rejecting
                            ? Promise.reject(new Error('RAW_CANCEL_ERROR'))
                            : new Promise(() => {});
                    },
                }),
                beforeRead
                    ? {
                          headers: {
                              'content-length': String(
                                  BOOTSTRAP_LIMITS.responseBytes + 1
                              ),
                          },
                      }
                    : {}
            );
            let timer;
            try {
                await Promise.race([
                    expectCode(
                        () => readBootstrapResponse(response),
                        'LOAD_BOOTSTRAP_HTTP_CAP'
                    ),
                    new Promise((_, reject) => {
                        timer = setTimeout(
                            () =>
                                reject(
                                    new Error('cancellation blocked refusal')
                                ),
                            1000
                        );
                    }),
                ]);
                assert.equal(cancelled, true);
                assert.equal(response.body.locked, false);
            } finally {
                clearTimeout(timer);
            }
        }
});

test('HTTP rejects redirects non-JSON arrays and unsafe raw responses', async () => {
    for (const response of [
        new Response('{}', {
            status: 302,
            headers: { location: 'https://example.invalid/' },
        }),
        new Response('RAW_CREDENTIALS_PROVIDER_RESPONSE'),
        new Response('[]'),
        new Response('{}', { status: 403 }),
    ])
        await expectCode(
            () => readBootstrapResponse(response),
            'LOAD_BOOTSTRAP_HTTP_RESPONSE'
        );
    await expectCode(
        () => readBootstrapResponse(new Response('{}', { status: 429 })),
        'LOAD_BOOTSTRAP_RATE_LIMITED'
    );
});

test('mock transport confines origins paths verbs cookie jars and credential lifetime', async () => {
    const calls = [];
    const transport = createBootstrapTransport(state(), {
        fetchImpl: async (url, init) => {
            calls.push({ url, init });
            return new Response('{}', {
                headers: {
                    'set-cookie':
                        'session=MOCK_SESSION_TOKEN; HttpOnly; Path=/',
                },
            });
        },
    });
    await transport.post('owner', 'sign-up/email', {
        email: 'mock@example.test',
        password: secret('owner'),
    });
    await transport.getSession('owner');
    await transport.getSession('reader');
    assert.equal(calls[0].url, 'http://127.0.0.1:43101/api/auth/sign-up/email');
    assert.equal(calls[0].init.headers.origin, 'http://127.0.0.1:43100');
    assert.equal(calls[0].init.redirect, 'manual');
    assert.equal(calls[1].init.method, 'GET');
    assert.equal(calls[1].init.headers.cookie, 'session=MOCK_SESSION_TOKEN');
    assert.equal(calls[2].init.headers.cookie, '');
    for (const operation of [
        'organization/invite-member',
        'organization/add-member',
        'admin/create-user',
        'api-key/create',
        'documents/create',
        'collections/create',
        'organization/../../admin',
    ])
        await expectCode(
            () => transport.post('owner', operation, {}),
            'LOAD_BOOTSTRAP_HTTP_OPERATION'
        );
    await expectCode(
        () => transport.getSession('admin'),
        'LOAD_BOOTSTRAP_HTTP_OPERATION'
    );
    assert.equal(calls.length, 3);
    transport.discardSessions();
    await expectCode(
        () => transport.getSession('owner'),
        'LOAD_BOOTSTRAP_HTTP_OPERATION'
    );
    assert.equal(calls.length, 3);
});

test('mock transport bounds request bytes cookies calls and finite fetch failures', async () => {
    let calls = 0;
    const transport = createBootstrapTransport(state(), {
        fetchImpl: async () => {
            calls++;
            return new Response('{}');
        },
    });
    await expectCode(
        () =>
            transport.post('owner', 'organization/create', {
                name: 'x'.repeat(BOOTSTRAP_LIMITS.requestBytes),
            }),
        'LOAD_BOOTSTRAP_HTTP_CAP'
    );
    assert.equal(calls, 0);
    const failed = createBootstrapTransport(state(), {
        fetchImpl: async () => {
            throw new Error('RAW_NETWORK_PASSWORD');
        },
    });
    await expectCode(
        () => failed.getSession('owner'),
        'LOAD_BOOTSTRAP_TRANSPORT_FAILED'
    );
    const cookies = createBootstrapTransport(state(), {
        fetchImpl: async () =>
            new Response('{}', {
                headers: { 'set-cookie': 'session=' + 'x'.repeat(8192) },
            }),
    });
    await expectCode(
        () => cookies.getSession('owner'),
        'LOAD_BOOTSTRAP_HTTP_COOKIE'
    );
    const bounded = createBootstrapTransport(state(), {
        fetchImpl: async () => new Response('{}'),
    });
    for (let n = 0; n < BOOTSTRAP_LIMITS.authCalls; n++)
        await bounded.getSession('owner');
    await expectCode(
        () => bounded.getSession('owner'),
        'LOAD_BOOTSTRAP_TIME_BUDGET'
    );
    assert.throws(() => createBootstrapTransport(state()), {
        code: 'LOAD_BOOTSTRAP_DEPENDENCIES',
    });
});

let passed = 0;
for (const item of cases) {
    await item.execute();
    passed++;
}
console.log(
    JSON.stringify({
        evidenceKind: 'SYNTHETIC_UNIT_TEST',
        passed,
        resourceActions: 0,
        httpActions: 0,
        databaseActions: 0,
        providerActions: 0,
        runtimeDraftOnly: DRAFT_ONLY && RUNTIME_DRAFT_ONLY,
    })
);
