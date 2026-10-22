import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// Only synthetic observations in a runner-owned disposable application DB.
// No provider, vector, object, application .env or private user data is used.
const connectionString = process.env.DATABASE_URL;
if (
    !connectionString ||
    !/^vectorix_(catalog|observability_schema)_test$/.test(
        new URL(connectionString).pathname.slice(1)
    ) ||
    new URL(connectionString).hostname !== '127.0.0.1'
)
    throw new Error(
        'Telemetry proofs require the owned loopback _test database.'
    );
const require = createRequire(
    new URL('../../packages/db/package.json', import.meta.url)
);
const { Client } = require('pg');
const clients = Array.from(
    { length: 5 },
    () => new Client({ connectionString })
);
const [admin, early, later, reporter, otherReporter] = clients;
const org = 'telemetry-lock-org';
const otherOrg = 'telemetry-lock-other-org';
const phase = {
    PLAN: {
        samples: '1',
        sumMicros: '1001',
        maxMicros: '1001',
        buckets: ['0', '1', ...Array(14).fill('0')],
    },
};
let proofs = 0;
const prove = (name) =>
    console.log(`Telemetry PostgreSQL proof ${++proofs}: ${name}`);
const track = (promise) => {
    void promise.catch(() => {});
    return promise;
};
async function blocked(client, blocker) {
    const pid = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0]
        .pid;
    return async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const observation = await admin.query(
                'SELECT $2=ANY(pg_blocking_pids($1)) AS blocked',
                [pid, blocker]
            );
            if (observation.rows[0]?.blocked) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.fail(
            'Expected real telemetry PostgreSQL lock wait was not observed.'
        );
    };
}
async function marker(client, id) {
    await client.query(
        `INSERT INTO "OrganizationRagTelemetry" ("organizationId","trackingSince","lastRecordedAt")
        VALUES($1,clock_timestamp(),clock_timestamp())`,
        [id]
    );
}
async function addNative(client) {
    return client.query(
        `INSERT INTO "RagOperationalHour" (
        "organizationId","bucketStart",workload,provider,"lastRecordedAt","nativeValidatedBatches","validatedVectors",
        "validatedPreparedBytes","validatedEstimatedInputTokens","knownProviderInputTokens","unknownBilledTokenBatches","phaseStats","failureCounts")
        VALUES($1,'2026-01-01T00:00Z','INDEX_SEMANTIC','OLLAMA',clock_timestamp(),1,2,6,2,7,1,$2,'{"PROVIDER":"1"}')
        ON CONFLICT ("organizationId","bucketStart",workload,provider) DO UPDATE SET
        "lastRecordedAt"=GREATEST(clock_timestamp(),"RagOperationalHour"."lastRecordedAt"),
        "nativeValidatedBatches"="RagOperationalHour"."nativeValidatedBatches"+1,
        "validatedVectors"="RagOperationalHour"."validatedVectors"+2,
        "validatedPreparedBytes"="RagOperationalHour"."validatedPreparedBytes"+6,
        "validatedEstimatedInputTokens"="RagOperationalHour"."validatedEstimatedInputTokens"+2,
        "knownProviderInputTokens"="RagOperationalHour"."knownProviderInputTokens"+7,
        "unknownBilledTokenBatches"="RagOperationalHour"."unknownBilledTokenBatches"+1,
        "phaseStats"=vectorix_telemetry_merge_phases("RagOperationalHour"."phaseStats",EXCLUDED."phaseStats",EXCLUDED.workload),
        "failureCounts"=vectorix_telemetry_merge_failures("RagOperationalHour"."failureCounts",EXCLUDED."failureCounts")`,
        [org, JSON.stringify(phase)]
    );
}
try {
    await Promise.all(clients.map((client) => client.connect()));
    for (const client of clients)
        await client.query("SET statement_timeout='10s'");
    await admin.query(
        'INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,$1,$1,now()),($2,$2,$2,now())',
        [org, otherOrg]
    );
    await marker(admin, org);
    await marker(admin, otherOrg);
    // Hold the first real row mutation so all four reporters contend, rather
    // than relying on Promise scheduling to claim concurrent merge coverage.
    await early.query('BEGIN');
    await addNative(early);
    const earlyPid = (await early.query('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
    const blockedLater = await blocked(later, earlyPid);
    const pending = track(addNative(later));
    await blockedLater();
    await early.query('COMMIT');
    await pending;
    await Promise.all(
        [early, later, reporter, otherReporter].map(async (client) => {
            for (let index = 0; index < 10; index++) await addNative(client);
        })
    );
    const merged = (
        await admin.query(
            'SELECT * FROM "RagOperationalHour" WHERE "organizationId"=$1',
            [org]
        )
    ).rows[0];
    assert.equal(merged.nativeValidatedBatches, '42');
    assert.equal(merged.validatedVectors, '84');
    assert.equal(merged.validatedPreparedBytes, '252');
    assert.equal(merged.knownProviderInputTokens, '294');
    assert.equal(merged.unknownBilledTokenBatches, '42');
    assert.equal(merged.sourceReadBytes, null);
    assert.equal(merged.phaseStats.PLAN.samples, '42');
    assert.equal(merged.phaseStats.PLAN.sumMicros, '42042');
    assert.equal(merged.phaseStats.PLAN.maxMicros, '1001');
    assert.equal(merged.phaseStats.PLAN.buckets[1], '42');
    assert.deepEqual(merged.failureCounts, { PROVIDER: '42' });
    assert.equal(
        (
            await admin.query(
                'SELECT count(*)::int AS n FROM "RagOperationalHour" WHERE "organizationId"=$1',
                [otherOrg]
            )
        ).rows[0].n,
        0
    );
    prove(
        'four contending reporters conserve numeric counters, exact histograms, unknowns and tenant scope'
    );

    // An older transaction_timestamp() must not overwrite a later observation.
    await early.query('BEGIN');
    await early.query('SELECT transaction_timestamp()');
    await new Promise((resolve) => setTimeout(resolve, 15));
    await later.query('BEGIN');
    await later.query(
        'UPDATE "OrganizationRagTelemetry" SET "lastRecordedAt"=clock_timestamp() WHERE "organizationId"=$1',
        [org]
    );
    const laterPid = (await later.query('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
    const clockBlocked = await blocked(early, laterPid);
    const staleTime = track(
        early.query(
            'UPDATE "OrganizationRagTelemetry" SET "lastRecordedAt"=now() WHERE "organizationId"=$1',
            [org]
        )
    );
    await clockBlocked();
    await later.query('COMMIT');
    await assert.rejects(staleTime, {
        code: '23514',
        constraint: 'OrganizationRagTelemetry_order',
    });
    await early.query('ROLLBACK');
    await early.query(
        'UPDATE "OrganizationRagTelemetry" SET "lastRecordedAt"=GREATEST(clock_timestamp(),"lastRecordedAt") WHERE "organizationId"=$1',
        [org]
    );
    prove(
        'real delayed old transaction cannot regress marker time; ordered clock_timestamp retry succeeds'
    );

    const startA = (
        await early.query(
            `INSERT INTO "RagWorkerLaneObservation" (lane,"lastScanStartObservedAt") VALUES('DOCUMENTS',clock_timestamp()) RETURNING "lastScanStartObservedAt"`
        )
    ).rows[0].lastScanStartObservedAt;
    await new Promise((resolve) => setTimeout(resolve, 15));
    const startB = (
        await later.query(
            `UPDATE "RagWorkerLaneObservation" SET "lastScanStartObservedAt"=GREATEST(clock_timestamp(),"lastScanStartObservedAt") WHERE lane='DOCUMENTS' RETURNING "lastScanStartObservedAt"`
        )
    ).rows[0].lastScanStartObservedAt;
    await early.query(
        `UPDATE "RagWorkerLaneObservation" SET "lastScanFinishObservedAt"=clock_timestamp(),"lastFinishedScanStartObservedAt"=$1,"lastFinishedScanDurationMicros"=1,"lastScanOutcome"='THREW',"lastSafeFailure"='SCAN_FAILED' WHERE lane='DOCUMENTS'`,
        [startA]
    );
    await later.query(
        `UPDATE "RagWorkerLaneObservation" SET "lastHeartbeatObservedAt"=clock_timestamp() WHERE lane='DOCUMENTS'`
    );
    const lane = (
        await admin.query(
            `SELECT * FROM "RagWorkerLaneObservation" WHERE lane='DOCUMENTS'`
        )
    ).rows[0];
    assert.equal(
        lane.lastScanStartObservedAt.toISOString(),
        startB.toISOString()
    );
    assert.equal(
        lane.lastFinishedScanStartObservedAt.toISOString(),
        startA.toISOString()
    );
    assert.equal(lane.lastSafeFailure, 'SCAN_FAILED');
    prove(
        'replica finish keeps its own observed start, independent later start and heartbeat do not clear failure'
    );

    // The existing organization FK, not a new task/resource lock, serializes
    // deletion with reporters. A reporter can never resurrect an organization.
    await later.query('BEGIN');
    await later.query(
        'UPDATE "OrganizationRagTelemetry" SET "lastRecordedAt"=clock_timestamp() WHERE "organizationId"=$1',
        [otherOrg]
    );
    // Existing marker UPDATE does not require a parent key-share lock; use a
    // new hour INSERT to prove the actual parent FK race.
    await later.query(
        `INSERT INTO "RagOperationalHour" ("organizationId","bucketStart",workload,provider,"lastRecordedAt") VALUES($1,'2026-01-01','EXTRACTION','NONE',clock_timestamp())`,
        [otherOrg]
    );
    const deleteBlocked = await blocked(early, laterPid);
    await early.query('BEGIN');
    const deletion = track(
        early.query('DELETE FROM organization WHERE id=$1', [otherOrg])
    );
    await deleteBlocked();
    await later.query('COMMIT');
    await deletion;
    await early.query('COMMIT');
    assert.equal(
        (
            await admin.query(
                'SELECT count(*)::int AS n FROM "RagOperationalHour" WHERE "organizationId"=$1',
                [otherOrg]
            )
        ).rows[0].n,
        0
    );
    prove(
        'reporter-first FK race ends in complete organization metadata cascade'
    );

    await admin.query(
        'INSERT INTO organization(id,name,slug,"createdAt") VALUES($1,$1,$1,now())',
        [otherOrg]
    );
    await early.query('BEGIN');
    await early.query('DELETE FROM organization WHERE id=$1', [otherOrg]);
    const insertBlocked = await blocked(later, earlyPid);
    const late = track(marker(later, otherOrg));
    await insertBlocked();
    await early.query('COMMIT');
    await assert.rejects(late, {
        code: '23503',
        constraint: 'OrganizationRagTelemetry_organizationId_fkey',
    });
    prove(
        'delete-first FK race rejects the late reporter without recreating parent or marker'
    );
    console.log(
        `Observability real-schema concurrency proofs: ${proofs} passed.`
    );
} finally {
    await Promise.allSettled(clients.map((client) => client.query('ROLLBACK')));
    try {
        await admin.query('DELETE FROM organization WHERE id=ANY($1::text[])', [
            [org, otherOrg],
        ]);
        await admin.query(
            `DELETE FROM "RagWorkerLaneObservation" WHERE lane='DOCUMENTS'`
        );
    } finally {
        await Promise.allSettled(clients.map((client) => client.end()));
    }
}
