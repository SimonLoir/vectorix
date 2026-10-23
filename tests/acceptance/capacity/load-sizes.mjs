/** Injected numeric store observations only. Importing performs no filesystem, client or resource work. */
import { performance } from 'node:perf_hooks';
import { digest, hash, id, validateIdentity } from './load-observer-core.mjs';
import { loadResourcePolicyHash } from './load-import-core.mjs';
import { getLoadPolicy } from './load-policy-registry.mjs';

export const RUNTIME_DRAFT_ONLY = true;
export const SIZE_LIMITS = Object.freeze({
    receiptBytes: 4096,
    relations: 256,
    transactionMs: 30000,
});
const SERVICES = ['postgres', 'vector', 'redis', 'rustfs', 'ollama'];

export class LoadSizeError extends Error {
    constructor(code = 'LOAD_SIZE_REFUSED') {
        super(
            /^LOAD_SIZE_[A-Z_]{1,64}$/u.test(code) ? code : 'LOAD_SIZE_REFUSED'
        );
        this.code = this.message;
    }
}
const need = (value, code) => {
    if (!value) throw new LoadSizeError(code);
};
const decimal = (value) =>
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n;
const inputScope = (input, state) => {
    need(
        input?.runId === state.runId &&
            ['pilot', 'full'].includes(input.phase) &&
            ['BEFORE', 'AFTER'].includes(input.moment),
        'LOAD_SIZE_SCOPE'
    );
    need(
        (input.collectionId === undefined ||
            input.collectionId === null ||
            id(input.collectionId)) &&
            (input.moment !== 'BEFORE' || input.collectionId == null),
        'LOAD_SIZE_SCOPE'
    );
};

/** Hash only fixed non-secret deployment/resource identity, never the environment or raw credentials. */
export function sizeBindings(state) {
    need(
        hash(state.lockfileSha256) &&
            hash(state.prismaConfigSha256) &&
            state.migrations &&
            Object.keys(state.migrations).length >= 1 &&
            Object.keys(state.migrations).length <= 64 &&
            Object.values(state.migrations).every(hash),
        'LOAD_SIZE_BINDING'
    );
    need(
        Object.keys(state.resources ?? {})
            .sort()
            .join(',') === [...SERVICES].sort().join(','),
        'LOAD_SIZE_BINDING'
    );
    const resources = Object.fromEntries(
        SERVICES.map((service) => {
            const row = state.resources[service];
            need(
                hash(row?.id) &&
                    typeof row.imageId === 'string' &&
                    /^sha256:[a-f0-9]{64}$/u.test(row.imageId) &&
                    hash(row.volumeIdentity),
                'LOAD_SIZE_BINDING'
            );
            return [
                service,
                {
                    id: row.id,
                    imageId: row.imageId,
                    volumeIdentity: row.volumeIdentity,
                },
            ];
        })
    );
    need(
        new Set(Object.values(resources).map((row) => row.id)).size ===
            SERVICES.length,
        'LOAD_SIZE_BINDING'
    );
    return {
        stateBindingSha256: digest({
            namespace: state.namespace,
            runId: state.runId,
            applicationDatabase: state.applicationDatabase,
            vectorDatabase: state.vectorDatabase,
            commit: state.commit,
            lockfileSha256: state.lockfileSha256,
            prismaConfigSha256: state.prismaConfigSha256,
            migrations: state.migrations,
        }),
        resourceIdentitySha256: digest(resources),
        resourcePolicySha256: loadResourcePolicyHash(state),
    };
}

function validateDatabaseObservation(value, kind, state) {
    const database =
        kind === 'application'
            ? state.applicationDatabase
            : state.vectorDatabase;
    const scope = kind === 'application' ? 'public' : 'vector_collections';
    need(
        value?.database === database &&
            value.scope === scope &&
            value.transactionReadOnly === true &&
            decimal(value.databaseBytes) &&
            BigInt(value.databaseBytes) > 0n &&
            decimal(value.scopedRelationBytes) &&
            Number.isSafeInteger(value.relationCount) &&
            value.relationCount >= 0 &&
            value.relationCount <= SIZE_LIMITS.relations,
        'LOAD_SIZE_DATABASE'
    );
    return {
        databaseBytes: value.databaseBytes,
        scopedRelationBytes: value.scopedRelationBytes,
        relationCount: value.relationCount,
        scope,
    };
}

/**
 * A whole-store receipt includes both fixture tenants and metadata/overhead. It is not collection
 * storage accounting, a simultaneous cross-store snapshot, source payload size or filesystem usage.
 */
export function createLoadSizeObserver({
    state,
    fixture,
    admit,
    readDatabase,
    producerIdentity,
    writeReceipt,
    now = Date.now,
    evidenceKind = 'SYNTHETIC_UNIT_TEST',
}) {
    validateIdentity(state, fixture);
    need(
        [admit, readDatabase, producerIdentity, writeReceipt, now].every(
            (value) => typeof value === 'function'
        ) && ['LIVE_READ_ONLY', 'SYNTHETIC_UNIT_TEST'].includes(evidenceKind),
        'LOAD_SIZE_ADAPTER'
    );
    const bindings = sizeBindings(state),
        used = new Set();
    let active = false;
    const time = () => {
        const value = now();
        need(
            Number.isSafeInteger(value) &&
                value >= 0 &&
                value <= 8640000000000000,
            'LOAD_SIZE_CLOCK'
        );
        return value;
    };
    return {
        async observeStoreSizes(input) {
            inputScope(input, state);
            const key = input.phase + '-' + input.moment.toLowerCase();
            need(!active && !used.has(key), 'LOAD_SIZE_REPLAY');
            active = true;
            used.add(key); // A failed/ambiguous read is retained; no hidden resampling of the phase.
            try {
                await admit();
                const identity = await producerIdentity();
                need(hash(identity), 'LOAD_SIZE_PRODUCER');
                const started = time();
                const reads = await Promise.allSettled(
                    ['application', 'vector'].map((kind) =>
                        readDatabase(kind, {
                            ...input,
                            collectionId: input.collectionId ?? null,
                        })
                    )
                );
                const failure = reads.find(
                    (value) => value.status === 'rejected'
                );
                if (failure) throw failure.reason;
                const observed = reads.map((value) => value.value);
                await admit();
                need(
                    (await producerIdentity()) === identity,
                    'LOAD_SIZE_PRODUCER'
                );
                const finished = time();
                need(finished >= started, 'LOAD_SIZE_CLOCK');
                need(
                    JSON.stringify(sizeBindings(state)) ===
                        JSON.stringify(bindings),
                    'LOAD_SIZE_BINDING'
                );
                const payload = {
                    schemaVersion: 1,
                    kind: 'INDEPENDENT_STORE_SIZES',
                    evidenceKind,
                    runId: state.runId,
                    phase: input.phase,
                    moment: input.moment,
                    collectionId: input.collectionId ?? null,
                    startedAt: new Date(started).toISOString(),
                    finishedAt: new Date(finished).toISOString(),
                    ...bindings,
                    producerIdentitySha256: identity,
                    application: validateDatabaseObservation(
                        observed[0],
                        'application',
                        state
                    ),
                    vector: validateDatabaseObservation(
                        observed[1],
                        'vector',
                        state
                    ),
                    physicalVolumeBytes: null,
                    physicalVolumeStatus: 'UNKNOWN',
                };
                const receipt = { ...payload, receiptSha256: digest(payload) };
                need(
                    Buffer.byteLength(JSON.stringify(receipt)) <=
                        SIZE_LIMITS.receiptBytes,
                    'LOAD_SIZE_BYTES'
                );
                await writeReceipt(
                    'store-sizes-' + key + '.json',
                    structuredClone(receipt)
                );
                return receipt;
            } catch (error) {
                if (error instanceof LoadSizeError) throw error;
                throw new LoadSizeError('LOAD_SIZE_REFUSED');
            } finally {
                active = false;
            }
        },
    };
}

const one = (result) => {
    need(result.rows.length === 1, 'LOAD_SIZE_DATABASE');
    return result.rows[0];
};

/**
 * SQL is necessary for PostgreSQL's physical database/relation-size functions. Both identifiers are
 * fixed/parameterized, and every observation verifies the actual database and read-only transaction.
 * Relation totals count ordinary/materialized relations with their indexes/TOAST, not directory bytes.
 */
export async function readStoreDatabaseSize(
    client,
    {
        database,
        experimentPolicyId = 'DEFAULT_V1',
        scope,
        collectionId = null,
        organizationId = null,
        now = () => performance.now(),
    }
) {
    let policy;
    try {
        policy = getLoadPolicy(experimentPolicyId);
    } catch {
        throw new LoadSizeError('LOAD_SIZE_DATABASE');
    }
    need(
        typeof database === 'string' &&
            new RegExp(
                `^${policy.databasePrefix}_(app|vectors)_[a-f0-9]{12}_test$`,
                'u'
            ).test(database) &&
            ['public', 'vector_collections'].includes(scope) &&
            (database.includes('_app_')
                ? scope === 'public'
                : scope === 'vector_collections'),
        'LOAD_SIZE_DATABASE'
    );
    need(
        collectionId === null ||
            (scope === 'public' && id(collectionId) && id(organizationId)),
        'LOAD_SIZE_SCOPE'
    );
    const started = now();
    need(Number.isFinite(started) && started >= 0, 'LOAD_SIZE_CLOCK');
    let begun = false;
    const query = async (sql, parameters) => {
        const before = now();
        need(
            Number.isFinite(before) &&
                before >= started &&
                before - started <= SIZE_LIMITS.transactionMs,
            'LOAD_SIZE_DEADLINE'
        );
        const value = await client.query(sql, parameters);
        const after = now();
        need(
            Number.isFinite(after) &&
                after >= before &&
                after - started <= SIZE_LIMITS.transactionMs,
            'LOAD_SIZE_DEADLINE'
        );
        return value;
    };
    try {
        begun = true;
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await query("SET LOCAL statement_timeout='5000ms'");
        await query("SET LOCAL lock_timeout='1000ms'");
        await query("SET LOCAL idle_in_transaction_session_timeout='15000ms'");
        const identity = one(
            await query(
                "SELECT pg_catalog.current_database() AS database,pg_catalog.current_setting('transaction_read_only') AS readonly"
            )
        );
        need(
            identity.database === database && identity.readonly === 'on',
            'LOAD_SIZE_DATABASE'
        );
        if (collectionId !== null) {
            const owned = one(
                await query(
                    'SELECT id FROM public."Collection" WHERE id=$1 AND "organizationId"=$2 AND "deletedAt" IS NULL',
                    [collectionId, organizationId]
                )
            );
            need(owned.id === collectionId, 'LOAD_SIZE_SCOPE');
        }
        const sizes = one(
            await query(
                `SELECT pg_catalog.pg_database_size($1::name)::text AS "databaseBytes",coalesce(sum(pg_catalog.pg_total_relation_size(c.oid)::numeric),0)::text AS "scopedRelationBytes",count(*)::integer AS "relationCount" FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$2 AND c.relkind IN ('r','m')`,
                [database, scope]
            )
        );
        need(
            decimal(sizes.databaseBytes) &&
                BigInt(sizes.databaseBytes) > 0n &&
                decimal(sizes.scopedRelationBytes) &&
                Number.isSafeInteger(sizes.relationCount) &&
                sizes.relationCount >= 0 &&
                sizes.relationCount <= SIZE_LIMITS.relations,
            'LOAD_SIZE_DATABASE'
        );
        await query('COMMIT');
        begun = false;
        return { database, scope, transactionReadOnly: true, ...sizes };
    } catch (error) {
        if (error instanceof LoadSizeError) throw error;
        throw new LoadSizeError('LOAD_SIZE_DATABASE');
    } finally {
        if (begun) await client.query('ROLLBACK').catch(() => {});
    }
}
