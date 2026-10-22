import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
    destinationTarget,
    identifier,
    sha256,
    fail,
    validateGeneration,
} from './validation';
import {
    VectorStoreError,
    type DestinationConfig,
    type GenerationSpec,
} from './types';
interface GenerationLedgerRow {
    organization_id: string;
    collection_id: string;
    destination_fingerprint: string;
    shape: Record<string, unknown>;
    state: 'READY' | 'TOMBSTONED';
}
/** Internal transaction wrapper always rolls back before sanitizing driver failures. */
export async function transaction<T>(
    pool: Pool,
    callback: (db: PoolClient) => Promise<T>,
    timeout = 10_000
) {
    let client: PoolClient | undefined;
    try {
        client = await pool.connect();
        await client.query('BEGIN');
        await client.query(
            "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', '5000', true), set_config('idle_in_transaction_session_timeout', '30000', true)",
            [String(timeout)]
        );
        const value = await callback(client);
        await client.query('COMMIT');
        return value;
    } catch (error) {
        if (client) await client.query('ROLLBACK').catch(() => {});
        if (error instanceof VectorStoreError) throw error;
        return fail('STORE_UNAVAILABLE');
    } finally {
        client?.release();
    }
}
export class Connection {
    readonly runtime!: Pool;
    readonly provisioner: Pool | undefined;
    readonly schema: string;
    readonly target: string;
    destinationFingerprint = '';
    private provisioningIdentity: Promise<string> | undefined;
    constructor(private readonly config: DestinationConfig) {
        this.target = destinationTarget(config);
        this.schema = identifier(config.schema);
        try {
            this.runtime = new Pool({
                connectionString: config.runtimeUrl,
                max: 4,
                connectionTimeoutMillis: 5000,
            });
            this.provisioner = config.provisioningUrl
                ? new Pool({
                      connectionString: config.provisioningUrl,
                      max: 2,
                      connectionTimeoutMillis: 5000,
                  })
                : undefined;
        } catch {
            return fail('INVALID_INPUT');
        }
        this.runtime.on('error', () => {});
        this.provisioner?.on('error', () => {});
    }
    async close() {
        try {
            await Promise.all([this.runtime.end(), this.provisioner?.end()]);
        } catch {
            fail('STORE_UNAVAILABLE');
        }
    }
    table(name: string) {
        return `${this.schema}.${identifier(name)}`;
    }
    /** First setup is provisioning-only; bootstrap roles/extensions remain an operator responsibility. */
    async initialize() {
        if (destinationTarget(this.config) !== this.target)
            fail('DESTINATION_DRIFT');
        if (this.provisioner && !this.provisioningIdentity) {
            this.provisioningIdentity = transaction(
                this.provisioner,
                async (db) => {
                    const role = (
                        await db.query(
                            "SELECT current_user,rolsuper,rolcreatedb,rolcreaterole,has_schema_privilege(current_user,$1,'CREATE') AS can_create FROM pg_roles WHERE rolname=current_user",
                            [this.schema.replaceAll('"', '')]
                        )
                    ).rows[0];
                    if (
                        !role ||
                        role.rolsuper ||
                        role.rolcreatedb ||
                        role.rolcreaterole ||
                        !role.can_create
                    )
                        fail('CAPABILITY_UNAVAILABLE');
                    await db.query(
                        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
                        [`vectorix-ledger-v1:${this.schema}`]
                    );
                    const extensions = await db.query(
                        "SELECT extname,extversion FROM pg_extension WHERE extname IN ('vector','vectorscale')"
                    );
                    const versions = new Map(
                        extensions.rows.map((r) => [r.extname, r.extversion])
                    );
                    if (
                        versions.get('vector') !== '0.8.7' ||
                        versions.get('vectorscale') !== '0.9.1'
                    )
                        fail('CAPABILITY_UNAVAILABLE');
                    await db.query(
                        `CREATE TABLE IF NOT EXISTS ${this.table('vx_identity')} (singleton boolean PRIMARY KEY CHECK(singleton), identity uuid NOT NULL, version integer NOT NULL CHECK(version=1))`
                    );
                    await db.query(
                        `INSERT INTO ${this.table('vx_identity')} VALUES(true,$1,1) ON CONFLICT DO NOTHING`,
                        [randomUUID()]
                    );
                    await db.query(`CREATE TABLE IF NOT EXISTS ${this.table('vx_generations')} (
        id uuid PRIMARY KEY, organization_id text NOT NULL, collection_id text NOT NULL,
        destination_fingerprint text NOT NULL, shape jsonb NOT NULL, state text NOT NULL CHECK(state IN ('READY','TOMBSTONED')))`);
                    await db.query(`CREATE TABLE IF NOT EXISTS ${this.table('vx_publications')} (
        generation_id uuid NOT NULL REFERENCES ${this.table('vx_generations')}(id), id uuid NOT NULL,
        document_id text NOT NULL, source_version_id uuid NOT NULL, expected_count integer NOT NULL CHECK(expected_count BETWEEN 1 AND 100000), manifest_hash text NOT NULL,
        epoch bigint NOT NULL CHECK(epoch>0), state text NOT NULL CHECK(state IN ('OPEN','SEALED','TOMBSTONED')),
        PRIMARY KEY(generation_id,id))`);
                    const result = await db.query(
                        `SELECT identity FROM ${this.table('vx_identity')} WHERE singleton`
                    );
                    return result.rows[0]?.identity as string;
                },
                120_000
            ).catch((error: unknown) => {
                this.provisioningIdentity = undefined;
                throw error;
            });
        }
        const identity = await this.provisioningIdentity;
        const runtimeIdentity = await transaction(this.runtime, async (db) => {
            const role = (
                await db.query(
                    "SELECT rolsuper,rolcreatedb,rolcreaterole,has_schema_privilege(current_user,$1,'CREATE') AS can_create FROM pg_roles WHERE rolname=current_user",
                    [this.schema.replaceAll('"', '')]
                )
            ).rows[0];
            if (
                !role ||
                role.rolsuper ||
                role.rolcreatedb ||
                role.rolcreaterole ||
                role.can_create
            )
                fail('CAPABILITY_UNAVAILABLE');
            return (
                await db.query(
                    `SELECT identity FROM ${this.table('vx_identity')} WHERE singleton`
                )
            ).rows[0]?.identity as string;
        });
        if (!runtimeIdentity || (identity && identity !== runtimeIdentity))
            fail('DESTINATION_DRIFT');
        this.destinationFingerprint = sha256(
            this.target + ':' + runtimeIdentity
        );
        return this.destinationFingerprint;
    }
    check(spec: GenerationSpec) {
        validateGeneration(spec);
        if (
            !this.destinationFingerprint ||
            spec.destinationFingerprint !== this.destinationFingerprint
        )
            fail('DESTINATION_DRIFT');
    }
    /** Shared generation lock permits concurrent publications and keeps DROP behind bounded readers/writers. */
    async lockGeneration(
        db: PoolClient,
        spec: GenerationSpec,
        exclusive = false,
        allowTombstone = false
    ) {
        this.check(spec);
        const row = (
            await db.query<GenerationLedgerRow>(
                `SELECT * FROM ${this.table('vx_generations')} WHERE id=$1 FOR ${exclusive ? 'UPDATE' : 'SHARE'}`,
                [spec.id]
            )
        ).rows[0];
        if (!row) fail('SHAPE_MISMATCH');
        const shape = {
            dimensions: spec.dimensions,
            metric: spec.metric,
            numericType: spec.numericType,
            indexType: spec.indexType,
        };
        // JSONB keys are canonicalized independently of object insertion order.
        if (
            row.organization_id !== spec.organizationId ||
            row.collection_id !== spec.collectionId ||
            row.destination_fingerprint !== spec.destinationFingerprint ||
            Object.keys(row.shape).length !== Object.keys(shape).length ||
            Object.entries(shape).some(
                ([key, value]) => row.shape[key] !== value
            )
        )
            fail('SHAPE_MISMATCH');
        if (row.state === 'TOMBSTONED' && !allowTombstone) fail('TOMBSTONED');
        return row;
    }
}
