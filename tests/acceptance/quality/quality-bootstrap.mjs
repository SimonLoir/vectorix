#!/usr/bin/env node
/** Guarded fixture protocol. Imports perform no filesystem, HTTP, SDK, database or resource work. */
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

export const DRAFT_ONLY = false;
export const BOOTSTRAP_LIMITS = Object.freeze({
    responseBytes: 128 * 1024,
    requestBytes: 4096,
    journalBytes: 64 * 1024,
    fixtureBytes: 16 * 1024,
    stateBytes: 128 * 1024,
    requestMs: 10000,
    durationMs: 5 * 60 * 1000,
    authCalls: 24,
});
export const READER_PERMISSION = Object.freeze({
    dashboard: Object.freeze(['read']),
    ragLibrary: Object.freeze(['read']),
    ragCollection: Object.freeze(['read']),
});
const ROLES = ['owner', 'reader', 'foreign'];
const ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SAFE_ERRORS = new Set([
    'QUALITY_BOOTSTRAP_DRAFT_ONLY',
    'QUALITY_BOOTSTRAP_ARGUMENTS',
    'QUALITY_BOOTSTRAP_CONFIG',
    'QUALITY_BOOTSTRAP_DEPENDENCIES',
    'QUALITY_BOOTSTRAP_PRIOR_PROGRESS',
    'QUALITY_BOOTSTRAP_PASSWORD',
    'QUALITY_BOOTSTRAP_NOT_EMPTY',
    'QUALITY_BOOTSTRAP_IDENTITIES',
    'QUALITY_BOOTSTRAP_ORGANIZATIONS',
    'QUALITY_BOOTSTRAP_MEMBERSHIPS',
    'QUALITY_BOOTSTRAP_READER_ROLE',
    'QUALITY_BOOTSTRAP_EMPTY_CATALOG',
    'QUALITY_BOOTSTRAP_NATIVE_IDENTITY',
    'QUALITY_BOOTSTRAP_NATIVE_ORGANIZATION',
    'QUALITY_BOOTSTRAP_NATIVE_SESSION',
    'QUALITY_BOOTSTRAP_MEMBER_CREATE',
    'QUALITY_BOOTSTRAP_CHECKPOINT_FAILED',
    'QUALITY_BOOTSTRAP_DATABASE_FAILED',
    'QUALITY_BOOTSTRAP_TRANSPORT_FAILED',
    'QUALITY_BOOTSTRAP_SESSION_DISCARD_FAILED',
    'QUALITY_BOOTSTRAP_RATE_LIMITED',
    'QUALITY_BOOTSTRAP_TIME_BUDGET',
    'QUALITY_BOOTSTRAP_FIXTURE',
    'QUALITY_BOOTSTRAP_PRIVATE_FILE',
    'QUALITY_BOOTSTRAP_GUARD_REFUSED',
    'QUALITY_BOOTSTRAP_HTTP_OPERATION',
    'QUALITY_BOOTSTRAP_HTTP_RESPONSE',
    'QUALITY_BOOTSTRAP_HTTP_CAP',
    'QUALITY_BOOTSTRAP_HTTP_COOKIE',
    'QUALITY_BOOTSTRAP_RUNTIME_FAILED',
]);

/** Only this finite diagnostic vocabulary may cross the private bootstrap boundary. */
export class QualityBootstrapError extends Error {
    constructor(code) {
        super(
            SAFE_ERRORS.has(code) ? code : 'QUALITY_BOOTSTRAP_RUNTIME_FAILED'
        );
        this.name = 'QualityBootstrapError';
        this.code = this.message;
    }
}
export function safeBootstrapError(
    error,
    fallback = 'QUALITY_BOOTSTRAP_RUNTIME_FAILED'
) {
    if (error instanceof QualityBootstrapError && SAFE_ERRORS.has(error.code))
        return error.code;
    if (error?.status === 429) return 'QUALITY_BOOTSTRAP_RATE_LIMITED';
    return SAFE_ERRORS.has(fallback)
        ? fallback
        : 'QUALITY_BOOTSTRAP_RUNTIME_FAILED';
}
export const bootstrapNeed = (condition, code) => {
    if (!condition) throw new QualityBootstrapError(code);
};
const copy = (value) => structuredClone(value);
const exactKeys = (value, keys) =>
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',');

/** Bind this protocol to one fresh owned quality run and its two exact loopback origins. */
export function validateBootstrapConfig(state) {
    bootstrapNeed(
        state &&
            state.schemaVersion === 1 &&
            state.namespace === 'vectorix-m7c-quality' &&
            /^[a-f0-9]{12}$/u.test(state.runId) &&
            state.prefix === 'vectorix-m7c-quality-' + state.runId &&
            ['SCHEMA_VERIFIED_EMPTY', 'BOOTSTRAPPING'].includes(state.phase),
        'QUALITY_BOOTSTRAP_CONFIG'
    );
    const ports = state.ports;
    bootstrapNeed(
        ports &&
            ['api', 'web', 'postgres'].every(
                (key) =>
                    Number.isInteger(ports[key]) &&
                    ports[key] > 1024 &&
                    ports[key] < 65536
            ) &&
            new Set([ports.api, ports.web, ports.postgres]).size === 3 &&
            state.apiOrigin === `http://127.0.0.1:${ports.api}` &&
            state.webOrigin === `http://127.0.0.1:${ports.web}`,
        'QUALITY_BOOTSTRAP_CONFIG'
    );
    bootstrapNeed(
        state.applicationDatabase ===
            `vectorix_m7c_quality_app_${state.runId}_test`,
        'QUALITY_BOOTSTRAP_CONFIG'
    );
    const env = state.environment;
    bootstrapNeed(
        env &&
            env.BETTER_AUTH_URL === state.apiOrigin &&
            env.API_URL === state.apiOrigin &&
            env.VECTORIX_WEB_URL === state.webOrigin &&
            env.TRUSTED_ORIGINS === state.webOrigin,
        'QUALITY_BOOTSTRAP_CONFIG'
    );
    let database;
    try {
        database = new URL(env.DATABASE_URL);
    } catch {
        throw new QualityBootstrapError('QUALITY_BOOTSTRAP_CONFIG');
    }
    bootstrapNeed(
        ['postgres:', 'postgresql:'].includes(database.protocol) &&
            database.hostname === '127.0.0.1' &&
            database.port === String(ports.postgres) &&
            database.username &&
            database.password &&
            database.pathname === '/' + state.applicationDatabase &&
            !database.search &&
            !database.hash,
        'QUALITY_BOOTSTRAP_CONFIG'
    );
    return state;
}

/** Project only the exact private collector fixture; sessions, headers and transport tokens never enter it. */
export function buildQualityFixture(state, users, organizations) {
    validateBootstrapConfig(state);
    bootstrapNeed(
        users &&
            ROLES.every(
                (role) => users[role] && typeof users[role] === 'object'
            ) &&
            organizations?.A &&
            organizations?.B,
        'QUALITY_BOOTSTRAP_FIXTURE'
    );
    const fixture = {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        runId: state.runId,
        users: Object.fromEntries(
            ROLES.map((role) => [
                role,
                {
                    userId: users[role]?.userId,
                    memberId: users[role]?.memberId,
                    organizationId:
                        role === 'foreign'
                            ? organizations.B?.id
                            : organizations.A?.id,
                    email: users[role]?.email,
                    password: users[role]?.password,
                },
            ])
        ),
        organizationIds: [organizations.A?.id, organizations.B?.id],
    };
    bootstrapNeed(
        exactKeys(fixture, [
            'schemaVersion',
            'namespace',
            'runId',
            'users',
            'organizationIds',
        ]) &&
            fixture.organizationIds.every(
                (id) => typeof id === 'string' && ID.test(id)
            ) &&
            new Set(fixture.organizationIds).size === 2 &&
            new Set(ROLES.map((role) => fixture.users[role].userId)).size ===
                3 &&
            new Set(ROLES.map((role) => fixture.users[role].memberId)).size ===
                3 &&
            new Set(ROLES.map((role) => fixture.users[role].password)).size ===
                3 &&
            ROLES.every((role) => {
                const user = fixture.users[role];
                return (
                    typeof user.userId === 'string' &&
                    ID.test(user.userId) &&
                    typeof user.memberId === 'string' &&
                    ID.test(user.memberId) &&
                    user.email ===
                        `m7c-quality-${role}-${state.runId}@example.test` &&
                    typeof user.password === 'string' &&
                    user.password.length >= 20 &&
                    user.password.length <= 200
                );
            }),
        'QUALITY_BOOTSTRAP_FIXTURE'
    );
    return fixture;
}

/** Bounded projections include the first forbidden extra row so exact-count checks cannot truncate extras away. */
async function snapshot(tx) {
    const [
        users,
        organizations,
        members,
        roles,
        keys,
        documents,
        collections,
        invitations,
        memberGrants,
        groupGrants,
    ] = await Promise.all([
        tx.user.findMany({
            take: 4,
            orderBy: { id: 'asc' },
            select: { id: true, email: true, isSuperAdmin: true },
        }),
        tx.organization.findMany({
            take: 3,
            orderBy: { id: 'asc' },
            select: { id: true, slug: true },
        }),
        tx.member.findMany({
            take: 4,
            orderBy: { id: 'asc' },
            select: {
                id: true,
                userId: true,
                organizationId: true,
                role: true,
            },
        }),
        tx.organizationRole.findMany({
            take: 2,
            orderBy: { id: 'asc' },
            select: {
                id: true,
                organizationId: true,
                role: true,
                permission: true,
            },
        }),
        tx.apikey.count(),
        tx.document.count(),
        tx.collection.count(),
        tx.invitation.count(),
        tx.collectionMemberGrant.count(),
        tx.collectionGroupGrant.count(),
    ]);
    bootstrapNeed(
        [users, organizations, members, roles].every(Array.isArray),
        'QUALITY_BOOTSTRAP_DATABASE_FAILED'
    );
    return {
        users,
        organizations,
        members,
        roles,
        keys,
        documents,
        collections,
        invitations,
        memberGrants,
        groupGrants,
    };
}
function emptyCatalog(value) {
    bootstrapNeed(
        [
            'keys',
            'documents',
            'collections',
            'invitations',
            'memberGrants',
            'groupGrants',
        ].every((key) => value[key] === 0),
        'QUALITY_BOOTSTRAP_EMPTY_CATALOG'
    );
}
function validateSaved(value, state, users, organizations, withReader) {
    emptyCatalog(value);
    bootstrapNeed(
        value.users.length === 3 &&
            new Set(value.users.map((u) => u.id)).size === 3 &&
            ROLES.every((role) =>
                value.users.some(
                    (saved) =>
                        saved.id === users[role].userId &&
                        saved.email === users[role].email &&
                        saved.isSuperAdmin === false
                )
            ),
        'QUALITY_BOOTSTRAP_IDENTITIES'
    );
    bootstrapNeed(
        value.organizations.length === 2 &&
            ['A', 'B'].every((suffix) =>
                value.organizations.some(
                    (saved) =>
                        saved.id === organizations[suffix].id &&
                        saved.slug ===
                            `m7c-quality-${state.runId}-${suffix.toLowerCase()}`
                )
            ),
        'QUALITY_BOOTSTRAP_ORGANIZATIONS'
    );
    const expected = [
        {
            userId: users.owner.userId,
            organizationId: organizations.A.id,
            role: 'owner',
        },
        {
            userId: users.foreign.userId,
            organizationId: organizations.B.id,
            role: 'owner',
        },
        ...(withReader
            ? [
                  {
                      userId: users.reader.userId,
                      organizationId: organizations.A.id,
                      role: `m7c-quality-reader-${state.runId}`,
                  },
              ]
            : []),
    ];
    bootstrapNeed(
        value.members.length === expected.length &&
            new Set(value.members.map((member) => member.id)).size ===
                expected.length &&
            value.members.every(
                (member) => typeof member.id === 'string' && ID.test(member.id)
            ) &&
            expected.every(
                (tuple) =>
                    value.members.filter(
                        (member) =>
                            member.userId === tuple.userId &&
                            member.organizationId === tuple.organizationId &&
                            member.role === tuple.role
                    ).length === 1
            ),
        'QUALITY_BOOTSTRAP_MEMBERSHIPS'
    );
    const role = value.roles[0];
    let permission;
    try {
        if (
            typeof role?.permission === 'string' &&
            Buffer.byteLength(role.permission) <= 1024
        )
            permission = JSON.parse(role.permission);
    } catch {
        /* A malformed saved role is refused with a finite diagnostic below. */
    }
    bootstrapNeed(
        value.roles.length === 1 &&
            typeof role?.id === 'string' &&
            ID.test(role.id) &&
            role.organizationId === organizations.A.id &&
            role.role === `m7c-quality-reader-${state.runId}` &&
            isDeepStrictEqual(permission, READER_PERMISSION),
        'QUALITY_BOOTSTRAP_READER_ROLE'
    );
    return value;
}

/**
 * Native signup/org/role setup with one explicitly synthetic member.create transaction.
 * Checkpoints are awaited before and after every mutation; any saved journal refuses automatic replay.
 * Injected clients are constructed only after the independently guarded runtime's fresh topology proof.
 */
export async function bootstrapQualityFixture({
    state,
    transport,
    database,
    checkpoint,
    priorJournal = null,
    randomPassword = () => randomBytes(32).toString('base64url'),
    randomId = randomUUID,
    now = Date.now,
} = {}) {
    validateBootstrapConfig(state);
    bootstrapNeed(priorJournal === null, 'QUALITY_BOOTSTRAP_PRIOR_PROGRESS');
    bootstrapNeed(
        typeof transport?.post === 'function' &&
            typeof transport?.getSession === 'function' &&
            typeof transport?.discardSessions === 'function' &&
            typeof database?.$transaction === 'function' &&
            typeof checkpoint === 'function' &&
            typeof randomPassword === 'function' &&
            typeof randomId === 'function' &&
            typeof now === 'function',
        'QUALITY_BOOTSTRAP_DEPENDENCIES'
    );
    let users;
    try {
        users = Object.fromEntries(
            ROLES.map((role) => [
                role,
                {
                    email: `m7c-quality-${role}-${state.runId}@example.test`,
                    password: randomPassword(role),
                },
            ])
        );
    } catch {
        throw new QualityBootstrapError('QUALITY_BOOTSTRAP_PASSWORD');
    }
    bootstrapNeed(
        ROLES.every(
            (role) =>
                typeof users[role].password === 'string' &&
                /^[\x21-\x7e]{20,200}$/u.test(users[role].password)
        ) && new Set(ROLES.map((role) => users[role].password)).size === 3,
        'QUALITY_BOOTSTRAP_PASSWORD'
    );
    let started;
    try {
        started = now();
    } catch {
        throw new QualityBootstrapError('QUALITY_BOOTSTRAP_TIME_BUDGET');
    }
    const organizations = {};
    bootstrapNeed(
        Number.isSafeInteger(started) && started >= 0,
        'QUALITY_BOOTSTRAP_TIME_BUDGET'
    );
    const journal = {
        schemaVersion: 1,
        namespace: 'vectorix-m7c-quality',
        runId: state.runId,
        status: 'BOOTSTRAPPING',
        actions: [],
    };
    const persist = async () => {
        try {
            await checkpoint(copy(journal));
        } catch {
            throw new QualityBootstrapError(
                'QUALITY_BOOTSTRAP_CHECKPOINT_FAILED'
            );
        }
    };
    const budget = () => {
        let current;
        try {
            current = now();
        } catch {
            throw new QualityBootstrapError('QUALITY_BOOTSTRAP_TIME_BUDGET');
        }
        bootstrapNeed(
            Number.isSafeInteger(current) &&
                current >= started &&
                current - started <= BOOTSTRAP_LIMITS.durationMs,
            'QUALITY_BOOTSTRAP_TIME_BUDGET'
        );
    };
    const transaction = async (work) => {
        try {
            budget();
            return await database.$transaction(work, {
                isolationLevel: 'Serializable',
                timeout: 10000,
                maxWait: 5000,
            });
        } catch (error) {
            throw new QualityBootstrapError(
                safeBootstrapError(error, 'QUALITY_BOOTSTRAP_DATABASE_FAILED')
            );
        }
    };
    const action = async (label, target, operation) => {
        budget();
        const entry = {
            sequence: journal.actions.length + 1,
            action: label,
            target: copy(target),
            status: 'PENDING',
        };
        journal.actions.push(entry);
        await persist();
        try {
            const evidence = await operation();
            entry.evidence = evidence;
            entry.status = 'ACCEPTED';
            await persist();
            return evidence;
        } catch (error) {
            entry.status = 'FAILED_OR_UNCERTAIN';
            entry.diagnostic = safeBootstrapError(
                error,
                'QUALITY_BOOTSTRAP_TRANSPORT_FAILED'
            );
            await persist();
            throw new QualityBootstrapError(entry.diagnostic);
        }
    };
    let sessionsDiscarded = false;
    try {
        await persist();
        const fresh = await transaction(snapshot);
        emptyCatalog(fresh);
        bootstrapNeed(
            ['users', 'organizations', 'members', 'roles'].every(
                (key) => fresh[key].length === 0
            ),
            'QUALITY_BOOTSTRAP_NOT_EMPTY'
        );
        for (const role of ROLES) {
            const result = await action(
                'signup',
                { role, email: users[role].email },
                async () => {
                    const saved = await transport.post(role, 'sign-up/email', {
                        name: `M7c quality ${role}`,
                        email: users[role].email,
                        password: users[role].password,
                    });
                    bootstrapNeed(
                        typeof saved?.user?.id === 'string' &&
                            ID.test(saved.user.id) &&
                            saved.user.email === users[role].email &&
                            !ROLES.some(
                                (other) => users[other].userId === saved.user.id
                            ),
                        'QUALITY_BOOTSTRAP_NATIVE_IDENTITY'
                    );
                    return { userId: saved.user.id, email: saved.user.email };
                }
            );
            users[role].userId = result.userId;
        }
        for (const [suffix, role] of [
            ['A', 'owner'],
            ['B', 'foreign'],
        ]) {
            organizations[suffix] = await action(
                'organization-create',
                { suffix, role },
                async () => {
                    const slug = `m7c-quality-${state.runId}-${suffix.toLowerCase()}`;
                    const saved = await transport.post(
                        role,
                        'organization/create',
                        {
                            name: `M7c quality ${suffix}`,
                            slug,
                        }
                    );
                    bootstrapNeed(
                        typeof saved?.id === 'string' &&
                            ID.test(saved.id) &&
                            saved.slug === slug &&
                            !Object.values(organizations).some(
                                (org) => org.id === saved.id
                            ),
                        'QUALITY_BOOTSTRAP_NATIVE_ORGANIZATION'
                    );
                    return { id: saved.id, slug };
                }
            );
            await action(
                'organization-set-active',
                { role, organizationId: organizations[suffix].id },
                async () => {
                    await transport.post(role, 'organization/set-active', {
                        organizationId: organizations[suffix].id,
                    });
                    return { organizationId: organizations[suffix].id };
                }
            );
        }
        const readerRole = `m7c-quality-reader-${state.runId}`;
        await action(
            'reader-role-create',
            { organizationId: organizations.A.id, role: readerRole },
            async () => {
                await transport.post('owner', 'organization/create-role', {
                    organizationId: organizations.A.id,
                    role: readerRole,
                    permission: copy(READER_PERMISSION),
                });
                return { organizationId: organizations.A.id, role: readerRole };
            }
        );
        const readerMemberId = randomId();
        bootstrapNeed(
            typeof readerMemberId === 'string' && ID.test(readerMemberId),
            'QUALITY_BOOTSTRAP_MEMBER_CREATE'
        );
        const accepted = await action(
            'synthetic-reader-member-create',
            {
                userId: users.reader.userId,
                organizationId: organizations.A.id,
                memberId: readerMemberId,
            },
            async () =>
                transaction(async (tx) => {
                    const before = validateSaved(
                        await snapshot(tx),
                        state,
                        users,
                        organizations,
                        false
                    );
                    bootstrapNeed(
                        !before.members.some(
                            (member) => member.id === readerMemberId
                        ),
                        'QUALITY_BOOTSTRAP_MEMBER_CREATE'
                    );
                    const timestamp = now();
                    bootstrapNeed(
                        Number.isSafeInteger(timestamp) &&
                            timestamp >= 0 &&
                            timestamp <= 8640000000000000,
                        'QUALITY_BOOTSTRAP_TIME_BUDGET'
                    );
                    const created = await tx.member.create({
                        data: {
                            id: readerMemberId,
                            userId: users.reader.userId,
                            organizationId: organizations.A.id,
                            role: readerRole,
                            createdAt: new Date(timestamp),
                        },
                    });
                    bootstrapNeed(
                        created?.id === readerMemberId &&
                            created.userId === users.reader.userId &&
                            created.organizationId === organizations.A.id &&
                            created.role === readerRole,
                        'QUALITY_BOOTSTRAP_MEMBER_CREATE'
                    );
                    const after = validateSaved(
                        await snapshot(tx),
                        state,
                        users,
                        organizations,
                        true
                    );
                    return {
                        memberIds: Object.fromEntries(
                            ROLES.map((role) => [
                                role,
                                after.members.find(
                                    (member) =>
                                        member.userId === users[role].userId
                                ).id,
                            ])
                        ),
                    };
                })
        );
        for (const role of ROLES)
            users[role].memberId = accepted.memberIds[role];
        await action(
            'organization-set-active',
            { role: 'reader', organizationId: organizations.A.id },
            async () => {
                await transport.post('reader', 'organization/set-active', {
                    organizationId: organizations.A.id,
                });
                return { organizationId: organizations.A.id };
            }
        );
        for (const role of ROLES) {
            budget();
            let value;
            try {
                value = await transport.getSession(role);
            } catch (error) {
                throw new QualityBootstrapError(
                    safeBootstrapError(
                        error,
                        'QUALITY_BOOTSTRAP_TRANSPORT_FAILED'
                    )
                );
            }
            const organizationId =
                role === 'foreign' ? organizations.B.id : organizations.A.id;
            bootstrapNeed(
                value?.user?.id === users[role].userId &&
                    value.user.email === users[role].email &&
                    value.session?.userId === users[role].userId &&
                    value.session.activeOrganizationId === organizationId,
                'QUALITY_BOOTSTRAP_NATIVE_SESSION'
            );
        }
        await transaction(async (tx) =>
            validateSaved(await snapshot(tx), state, users, organizations, true)
        );
        const fixture = buildQualityFixture(state, users, organizations);
        try {
            await transport.discardSessions();
            sessionsDiscarded = true;
        } catch {
            throw new QualityBootstrapError(
                'QUALITY_BOOTSTRAP_SESSION_DISCARD_FAILED'
            );
        }
        journal.status = 'VALIDATED';
        await persist();
        return fixture;
    } catch (error) {
        journal.status = 'INCOMPLETE';
        journal.diagnostic = safeBootstrapError(error);
        await persist();
        throw new QualityBootstrapError(journal.diagnostic);
    } finally {
        if (!sessionsDiscarded)
            try {
                await transport.discardSessions();
            } catch {
                journal.status = 'INCOMPLETE';
                journal.diagnostic = 'QUALITY_BOOTSTRAP_SESSION_DISCARD_FAILED';
                await persist();
                throw new QualityBootstrapError(journal.diagnostic);
            }
    }
}

/** Explicit CLI adapter; native setup still requires exact private state and independent resource guards. */
export async function qualityBootstrapCli(args = process.argv.slice(2)) {
    if (DRAFT_ONLY)
        throw new QualityBootstrapError('QUALITY_BOOTSTRAP_DRAFT_ONLY');
    const { runBootstrapRuntime } =
        await import('./quality-bootstrap-runtime.mjs');
    return await runBootstrapRuntime(args);
}
if (
    process.argv[1] &&
    pathToFileURL(process.argv[1]).href === import.meta.url
) {
    qualityBootstrapCli().catch((error) => {
        console.error(
            JSON.stringify({
                completed: false,
                status: 'NOT_RUN_OR_INCOMPLETE',
                diagnostic: safeBootstrapError(error),
            })
        );
        process.exitCode = 1;
    });
}
