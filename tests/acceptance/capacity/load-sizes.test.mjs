/** Numeric/mock transactions only. No socket, DB, Docker, provider or actual process is inspected. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getLoadPolicy, policySha256 } from './load-policy-registry.mjs';
import { digest } from './load-observer-core.mjs';
import { privateCheckpoint } from './load-private.mjs';
import {
    createLoadSizeObserver,
    readStoreDatabaseSize,
    sizeBindings,
    RUNTIME_DRAFT_ONLY,
} from './load-sizes.mjs';
import {
    createLoadSizeRuntime,
    STATIC_DRAFT_ONLY,
} from './load-sizes-runtime.mjs';

const run = '0123456789ab',
    h = (char) => char.repeat(64);
function fixtureState() {
    const policy = getLoadPolicy('DEFAULT_V1'),
        namespace = policy.namespace,
        applicationDatabase = `vectorix_m7c_load_app_${run}_test`,
        vectorDatabase = `vectorix_m7c_load_vectors_${run}_test`;
    const state = {
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        schemaVersion: 1,
        namespace,
        runId: run,
        prefix: namespace + '-' + run,
        applicationDatabase,
        vectorDatabase,
        ports: { postgres: 45001, vector: 45002 },
        commit: 'a'.repeat(40),
        lockfileSha256: h('b'),
        prismaConfigSha256: h('c'),
        migrations: { '20261031000000_sql_function_search_path': h('d') },
        images: { postgres: 'sha256:' + h('e') },
        resourceLimits: { postgres: { cpus: '2', memoryBytes: 2147483648 } },
        loadPolicy: structuredClone(policy.loadPolicy),
        resources: Object.fromEntries(
            ['postgres', 'vector', 'redis', 'rustfs', 'ollama'].map(
                (service, index) => [
                    service,
                    {
                        id: String(index).repeat(64),
                        imageId: 'sha256:' + h('e'),
                        volumeIdentity: h('f'),
                    },
                ]
            )
        ),
    };
    state.environment = {
        DATABASE_URL: `postgresql://postgres:SYNTHETIC_SECRET@127.0.0.1:45001/${applicationDatabase}`,
        VECTOR_DATABASE_URL: `postgresql://runtime:SYNTHETIC_SECRET@127.0.0.1:45002/${vectorDatabase}`,
    };
    const fixture = {
        experimentPolicyId: policy.id,
        experimentPolicySha256: policySha256(policy),
        schemaVersion: 1,
        namespace,
        runId: run,
        organizationIds: ['orgA', 'orgB'],
        users: {
            owner: { userId: 'owner', organizationId: 'orgA' },
            reader: { userId: 'reader', organizationId: 'orgA' },
            foreign: { userId: 'foreign', organizationId: 'orgB' },
        },
    };
    return { state, fixture };
}
const input = {
    runId: run,
    phase: 'pilot',
    moment: 'BEFORE',
    collectionId: null,
};
const databaseValue = (kind, state) => ({
    database:
        kind === 'application'
            ? state.applicationDatabase
            : state.vectorDatabase,
    scope: kind === 'application' ? 'public' : 'vector_collections',
    databaseBytes: '20480',
    scopedRelationBytes: '10240',
    relationCount: kind === 'application' ? 64 : 6,
    transactionReadOnly: true,
});
function injected({ read, admit, producer, clock, writer } = {}) {
    const { state, fixture } = fixtureState(),
        writes = [],
        calls = [];
    let time = 1000;
    const observer = createLoadSizeObserver({
        state,
        fixture,
        admit:
            admit ??
            (async () => {
                calls.push('guard');
            }),
        readDatabase: async (kind, request) => {
            calls.push(kind);
            return read
                ? read(kind, request, state)
                : databaseValue(kind, state);
        },
        producerIdentity: producer ?? (() => h('a')),
        writeReceipt: async (name, value) => {
            if (writer) await writer(name, value);
            assert(!writes.some((row) => row.name === name));
            writes.push({ name, value });
        },
        now: clock ?? (() => time++),
    });
    return { observer, state, fixture, writes, calls };
}

test('real size entry refuses disabled or malformed state before files/SDK access', async () => {
    assert.equal(RUNTIME_DRAFT_ONLY, true);
    assert.equal(typeof STATIC_DRAFT_ONLY, 'boolean');
    await assert.rejects(() => createLoadSizeRuntime({ state: null }), {
        code: STATIC_DRAFT_ONLY
            ? 'LOAD_SIZE_RUNTIME_DISABLED'
            : 'LOAD_OBS_SCOPE',
    });
});
test('before/after receipts contain exact decimal numeric DB measures, stable identity hashes and explicit physical UNKNOWN', async () => {
    const io = injected();
    const before = await io.observer.observeStoreSizes(input);
    assert.equal(before.evidenceKind, 'SYNTHETIC_UNIT_TEST');
    assert.equal(before.collectionId, null);
    assert.deepEqual(before.application, {
        databaseBytes: '20480',
        scopedRelationBytes: '10240',
        relationCount: 64,
        scope: 'public',
    });
    assert.equal(before.physicalVolumeBytes, null);
    assert.equal(before.physicalVolumeStatus, 'UNKNOWN');
    const { receiptSha256, ...payload } = before;
    assert.equal(receiptSha256, digest(payload));
    assert.equal(io.writes[0].name, 'store-sizes-pilot-before.json');
    assert.deepEqual(io.writes[0].value, before);
    assert.equal(io.calls.filter((value) => value === 'guard').length, 2);
    assert(!JSON.stringify(before).includes('SYNTHETIC_SECRET'));
    assert(!JSON.stringify(before).includes('postgresql:'));
    await assert.rejects(() => io.observer.observeStoreSizes(input), {
        code: 'LOAD_SIZE_REPLAY',
    });
    const after = await io.observer.observeStoreSizes({
        ...input,
        moment: 'AFTER',
        collectionId: 'ownedCollection',
    });
    assert.equal(after.collectionId, 'ownedCollection');
    assert.equal(io.writes[1].name, 'store-sizes-pilot-after.json');
});
test('invalid namespace, database, mutable identities and guard refusal cannot record a fabricated size', async () => {
    const { state, fixture } = fixtureState();
    assert.throws(() =>
        createLoadSizeObserver({
            state: { ...state, namespace: 'vectorix-m7c-quality' },
            fixture,
        })
    );
    const altered = structuredClone(state);
    altered.resources.vector.id = altered.resources.postgres.id;
    assert.throws(() => sizeBindings(altered), { code: 'LOAD_SIZE_BINDING' });
    const io = injected({
        admit: async () => {
            throw new Error('SYNTHETIC_SECRET');
        },
    });
    await assert.rejects(
        () => io.observer.observeStoreSizes(input),
        (error) =>
            error.code === 'LOAD_SIZE_REFUSED' &&
            !error.message.includes('SECRET')
    );
    assert.equal(io.writes.length, 0);
    assert.equal(io.calls.length, 0);
    await assert.rejects(() => io.observer.observeStoreSizes(input), {
        code: 'LOAD_SIZE_REPLAY',
    });
    const scoped = injected();
    await assert.rejects(
        () =>
            scoped.observer.observeStoreSizes({
                ...input,
                collectionId: 'cannotExistBeforeImport',
            }),
        { code: 'LOAD_SIZE_SCOPE' }
    );
    assert.equal(scoped.calls.length, 0);
});
test('both reads drain on failure, concurrent phases refuse, and no rejected or partial measurement is persisted', async () => {
    let release, started;
    const began = new Promise((resolve) => (started = resolve)),
        pending = new Promise((resolve) => (release = resolve));
    const io = injected({
        read: async (kind, _input, state) => {
            if (kind === 'application')
                throw new Error('SYNTHETIC_PRIVATE_DB_FAILURE');
            started();
            await pending;
            return databaseValue(kind, state);
        },
    });
    const observed = io.observer.observeStoreSizes(input);
    await began;
    await assert.rejects(
        () => io.observer.observeStoreSizes({ ...input, moment: 'AFTER' }),
        { code: 'LOAD_SIZE_REPLAY' }
    );
    assert.equal(io.writes.length, 0);
    release();
    await assert.rejects(
        () => observed,
        (error) =>
            error.code === 'LOAD_SIZE_REFUSED' &&
            !error.message.includes('PRIVATE')
    );
    assert.equal(io.writes.length, 0);
});
test('wrong actual DB/read-only state, invalid counters, impossible relation counts and producer drift fail closed', async () => {
    for (const change of [
        (value) => (value.database = 'production'),
        (value) => (value.scope = 'pg_catalog'),
        (value) => (value.transactionReadOnly = false),
        (value) => (value.databaseBytes = 'NaN'),
        (value) => (value.databaseBytes = 20480),
        (value) => (value.databaseBytes = '9223372036854775808'),
        (value) => (value.scopedRelationBytes = '1e3'),
        (value) => (value.relationCount = 257),
        (value) => (value.relationCount = -1),
    ]) {
        const io = injected({
            read: async (kind, _input, state) => {
                const value = databaseValue(kind, state);
                if (kind === 'application') change(value);
                return value;
            },
        });
        await assert.rejects(() => io.observer.observeStoreSizes(input), {
            code: 'LOAD_SIZE_DATABASE',
        });
        assert.equal(io.writes.length, 0);
    }
    let n = 0;
    const drift = injected({ producer: () => (++n === 1 ? h('a') : h('b')) });
    await assert.rejects(() => drift.observer.observeStoreSizes(input), {
        code: 'LOAD_SIZE_PRODUCER',
    });
    assert.equal(drift.writes.length, 0);
    let time = 2000;
    const clock = injected({ clock: () => time-- });
    await assert.rejects(() => clock.observer.observeStoreSizes(input), {
        code: 'LOAD_SIZE_CLOCK',
    });
    assert.equal(clock.writes.length, 0);
});

function sqlMock({
    database,
    readonly = 'on',
    owned = true,
    reply,
    error,
    tick,
} = {}) {
    const calls = [];
    return {
        calls,
        async query(sql, parameters) {
            calls.push({ sql, parameters });
            tick?.(sql);
            if (error?.(sql))
                throw new Error('SYNTHETIC_PRIVATE_DATABASE_DETAIL');
            if (sql.startsWith('SELECT pg_catalog.current_database'))
                return { rows: [{ database, readonly }] };
            if (sql.startsWith('SELECT id FROM'))
                return { rows: owned ? [{ id: 'ownedCollection' }] : [] };
            if (sql.includes('pg_database_size'))
                return {
                    rows: [
                        reply ?? {
                            databaseBytes: '32768',
                            scopedRelationBytes: '16384',
                            relationCount: 64,
                        },
                    ],
                };
            return { rows: [] };
        },
    };
}
test('SQL observes current DB in READ ONLY and parameterizes whole-store/relation sizes plus the optional owned target', async () => {
    const { state } = fixtureState(),
        client = sqlMock({ database: state.applicationDatabase });
    const result = await readStoreDatabaseSize(client, {
        database: state.applicationDatabase,
        scope: 'public',
        collectionId: 'ownedCollection',
        organizationId: 'orgA',
    });
    assert.deepEqual(result, {
        database: state.applicationDatabase,
        scope: 'public',
        transactionReadOnly: true,
        databaseBytes: '32768',
        scopedRelationBytes: '16384',
        relationCount: 64,
    });
    assert.equal(
        client.calls[0].sql,
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    assert.equal(client.calls.at(-1).sql, 'COMMIT');
    assert(client.calls.some((row) => row.sql.includes('statement_timeout')));
    assert.deepEqual(
        client.calls.find((row) => row.sql.includes('pg_database_size'))
            .parameters,
        [state.applicationDatabase, 'public']
    );
    assert.deepEqual(
        client.calls.find((row) => row.sql.startsWith('SELECT id FROM'))
            .parameters,
        ['ownedCollection', 'orgA']
    );
    assert(
        !client.calls.some((row) =>
            /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u.test(row.sql)
        )
    );
});
test('SQL wrong database/read-only target, missing tenant and native query errors rollback and stay sanitized', async () => {
    const { state } = fixtureState();
    for (const options of [
        { database: 'production' },
        { database: state.applicationDatabase, readonly: 'off' },
        { database: state.applicationDatabase, owned: false },
        {
            database: state.applicationDatabase,
            error: (sql) => sql.includes('pg_database_size'),
        },
    ]) {
        const client = sqlMock(options);
        await assert.rejects(
            () =>
                readStoreDatabaseSize(client, {
                    database: state.applicationDatabase,
                    scope: 'public',
                    collectionId: 'ownedCollection',
                    organizationId: 'orgA',
                }),
            (error) =>
                /^LOAD_SIZE_/u.test(error.code) &&
                !error.message.includes('PRIVATE')
        );
        assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
    }
    const never = sqlMock({ database: state.applicationDatabase });
    await assert.rejects(
        () =>
            readStoreDatabaseSize(never, {
                database: 'application',
                scope: 'public',
            }),
        { code: 'LOAD_SIZE_DATABASE' }
    );
    assert.equal(never.calls.length, 0);
});
test('the total SQL budget is checked after every awaited query including BEGIN and always attempts rollback', async () => {
    const { state } = fixtureState();
    for (const at of ['BEGIN', 'pg_database_size']) {
        let clock = 0;
        const client = sqlMock({
            database: state.applicationDatabase,
            tick: (sql) => {
                if (sql.includes(at)) clock = 30001;
            },
        });
        await assert.rejects(
            () =>
                readStoreDatabaseSize(client, {
                    database: state.applicationDatabase,
                    scope: 'public',
                    now: () => clock,
                }),
            { code: 'LOAD_SIZE_DEADLINE' }
        );
        assert.equal(client.calls.at(-1).sql, 'ROLLBACK');
        assert(!client.calls.some((row) => row.sql === 'COMMIT'));
    }
});

test('a synthetic receipt uses the existing exclusive600 sink without overwriting evidence or persisting secrets', async () => {
    const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), 'vectorix-load-size-pure-')
    );
    fs.chmodSync(directory, 0o700);
    try {
        const io = injected({
            writer: async (name, receipt) =>
                privateCheckpoint(path.join(directory, name), receipt, true),
        });
        const receipt = await io.observer.observeStoreSizes(input);
        const filename = path.join(directory, 'store-sizes-pilot-before.json');
        const info = fs.lstatSync(filename);
        assert.equal(info.mode & 0o777, 0o600);
        assert.equal(info.isSymbolicLink(), false);
        assert(info.size <= 4096);
        assert.deepEqual(
            JSON.parse(fs.readFileSync(filename, 'utf8')),
            receipt
        );
        assert.throws(
            () => privateCheckpoint(filename, { overwritten: true }, true),
            { code: 'EEXIST' }
        );
        assert(!fs.readFileSync(filename, 'utf8').includes('SYNTHETIC_SECRET'));
    } finally {
        fs.rmSync(directory, { recursive: true });
    }
});
