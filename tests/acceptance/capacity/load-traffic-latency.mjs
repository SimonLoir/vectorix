/** Load-only read-only latency adapter and finite cohort checks; never imports the quality runtime/validator. */
import {
    need,
    decimal,
    digest,
    same,
    fields,
    validateIdentity,
    LoadObservationError,
} from './load-observer-core.mjs';
import { reconcileCohort, MODES } from './load-traffic.mjs';
import { loadObserverGuard } from './load-observer-runtime.mjs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const STATIC_DRAFT_ONLY = false;
const PHASES = ['SERVICE_TOTAL', 'INTERNAL_PHASE_UNION', 'QUERY_EMBED'];
const zero = () => ({
    samples: '0',
    sumMicros: '0',
    buckets: Array(16).fill('0'),
});
const key = (row) => [row.organizationId, row.workload, row.provider].join('/');
/** Aggregation and phase bins stay in PostgreSQL; at most22dimensions and720hour keys per dimension are returned. */
export async function readLoadSearchSnapshot(
    client,
    { state, fixture, producerIdentitySha256, now = () => performance.now() }
) {
    validateIdentity(state, fixture);
    const deadline = now() + 30000;
    let begun = false;
    const query = async (sql, args) => {
        need(now() <= deadline, 'LOAD_OBS_READ_DEADLINE');
        const result = await client.query(sql, args);
        need(now() <= deadline, 'LOAD_OBS_READ_DEADLINE');
        return result;
    };
    try {
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        begun = true;
        await query("SET LOCAL statement_timeout='5000ms'");
        await query("SET LOCAL lock_timeout='1000ms'");
        const check = await query(
            "SELECT current_database() AS database,current_setting('transaction_read_only') AS readonly"
        );
        need(
            check.rows.length === 1 &&
                check.rows[0].database === state.applicationDatabase &&
                check.rows[0].readonly === 'on',
            'LOAD_OBS_DATABASE'
        );
        const orgs = [...fixture.organizationIds].sort(),
            scope = `"organizationId"=ANY($1::text[]) AND workload IN ('SEARCH_LEXICAL','SEARCH_VECTOR','SEARCH_HYBRID')`;
        const inventory = (
            await query(
                'SELECT count(*)::text AS count,bool_and("formatVersion"=1) AS valid FROM "RagOperationalHour" WHERE ' +
                    scope,
                [orgs]
            )
        ).rows[0];
        need(
            inventory &&
                decimal(inventory.count) <= 15840n &&
                (inventory.valid === true || inventory.count === '0'),
            'LOAD_OBS_LATENCY_BOUND'
        );
        const markers = (
            await query(
                'SELECT "organizationId","formatVersion","knownGapReports"::text FROM "OrganizationRagTelemetry" WHERE "organizationId"=ANY($1::text[]) ORDER BY "organizationId"',
                [orgs]
            )
        ).rows;
        need(
            markers.length <= 2 &&
                markers.every((row) => row.formatVersion === 1),
            'LOAD_OBS_MARKER'
        );
        const scalars = (
            await query(
                `SELECT "organizationId",workload::text,provider::text,array_agg("bucketStart" ORDER BY "bucketStart") AS hours,${fields.map((field) => `sum("${field}"::numeric)::text AS "${field}"`).join(',')},sum((SELECT coalesce(sum(value::numeric),0) FROM jsonb_each_text("failureCounts")))::text AS "failureClassTotal" FROM "RagOperationalHour" WHERE ${scope} GROUP BY "organizationId",workload,provider ORDER BY "organizationId",workload,provider`,
                [orgs]
            )
        ).rows;
        const phases = (
            await query(
                `WITH entries AS (SELECT "organizationId",workload,provider,p.key AS phase,p.value AS stats FROM "RagOperationalHour",LATERAL jsonb_each("phaseStats") p WHERE ${scope} AND p.key IN ('SERVICE_TOTAL','INTERNAL_PHASE_UNION','QUERY_EMBED')), totals AS (SELECT "organizationId",workload,provider,phase,sum((stats->>'samples')::numeric)::text AS samples,sum((stats->>'sumMicros')::numeric)::text AS "sumMicros" FROM entries GROUP BY "organizationId",workload,provider,phase), bins AS (SELECT "organizationId",workload,provider,phase,ordinality,sum(value::numeric)::text AS count FROM entries,LATERAL jsonb_array_elements_text(stats->'buckets') WITH ORDINALITY GROUP BY "organizationId",workload,provider,phase,ordinality) SELECT t."organizationId",t.workload::text,t.provider::text,t.phase,t.samples,t."sumMicros",array_agg(b.count ORDER BY b.ordinality) AS buckets FROM totals t JOIN bins b USING("organizationId",workload,provider,phase) GROUP BY t."organizationId",t.workload,t.provider,t.phase,t.samples,t."sumMicros" ORDER BY t."organizationId",t.workload,t.provider,t.phase`,
                [orgs]
            )
        ).rows;
        need(
            scalars.length <= 22 && phases.length <= 66,
            'LOAD_OBS_LATENCY_BOUND'
        );
        const marker = (organizationId) =>
            markers.find((row) => row.organizationId === organizationId)
                ?.knownGapReports ?? '0';
        const dimensions = scalars.map((row) => {
            need(
                orgs.includes(row.organizationId) &&
                    MODES.some((mode) => 'SEARCH_' + mode === row.workload) &&
                    (row.workload === 'SEARCH_LEXICAL'
                        ? row.provider === 'NONE'
                        : [
                              'OLLAMA',
                              'COHERE',
                              'VOYAGE',
                              'OPENAI',
                              'MISTRAL',
                          ].includes(row.provider)) &&
                    row.hours.length <= 720,
                'LOAD_OBS_LATENCY_SCOPE'
            );
            return {
                organizationId: row.organizationId,
                workload: row.workload,
                provider: row.provider,
                hours: row.hours.map((value) => new Date(value).toISOString()),
                formatVersion: 1,
                knownGapReports: marker(row.organizationId),
                failureClassTotal: row.failureClassTotal,
                counters: Object.fromEntries(
                    fields.map((field) => [field, row[field]])
                ),
                phases: Object.fromEntries(
                    PHASES.map((name) => {
                        const matches = phases.filter(
                            (value) =>
                                key(value) === key(row) && value.phase === name
                        );
                        need(matches.length <= 1, 'LOAD_OBS_LATENCY_SCOPE');
                        return [
                            name,
                            matches.length
                                ? {
                                      samples: matches[0].samples,
                                      sumMicros: matches[0].sumMicros,
                                      buckets: matches[0].buckets,
                                  }
                                : zero(),
                        ];
                    })
                ),
            };
        });
        need(
            new Set(dimensions.map(key)).size === dimensions.length,
            'LOAD_OBS_LATENCY_SCOPE'
        );
        const result = {
            schemaVersion: 1,
            runId: state.runId,
            producerIdentitySha256,
            markers: orgs.map((organizationId) => ({
                organizationId,
                knownGapReports: marker(organizationId),
            })),
            dimensions,
        };
        need(
            Buffer.byteLength(JSON.stringify(result)) <= 1024 ** 2,
            'LOAD_OBS_LATENCY_BOUND'
        );
        await query('COMMIT');
        begun = false;
        return result;
    } finally {
        if (begun) await client.query('ROLLBACK').catch(() => {});
    }
}
const empty = (organizationId, mode, knownGapReports) => ({
    organizationId,
    workload: 'SEARCH_' + mode,
    provider: mode === 'LEXICAL' ? 'NONE' : 'OLLAMA',
    hours: [],
    formatVersion: 1,
    knownGapReports,
    failureClassTotal: '0',
    counters: Object.fromEntries(fields.map((field) => [field, '0'])),
    phases: Object.fromEntries(PHASES.map((name) => [name, zero()])),
});
/** Extra dimensions and any dropped/failed cohort remain visible; a stable incomplete sample never passes. */
export function evaluateLoadSearch({ before, after, fixture, trace }) {
    try {
        need(
            before.runId === after.runId &&
                before.producerIdentitySha256 ===
                    after.producerIdentitySha256 &&
                same(before.markers, after.markers),
            'LOAD_OBS_LATENCY_PRODUCER'
        );
        need(
            trace.requests.every(
                (row) => row.state === 'FINISHED' && row.outcome === 'SUCCESS'
            ) &&
                trace.occupiedSlots === 0 &&
                trace.transportInFlight === 0 &&
                !trace.afterDrainDeadline,
            'LOAD_OBS_LATENCY_RECEIPT'
        );
        const orgs = {
                A: fixture.users.owner.organizationId,
                B: fixture.users.foreign.organizationId,
            },
            allowed = new Set(
                Object.values(orgs).flatMap((organizationId) =>
                    MODES.map((mode) => key(empty(organizationId, mode, '0')))
                )
            );
        for (const row of before.dimensions)
            need(
                after.dimensions.some(
                    (value) =>
                        key(value) === key(row) &&
                        row.hours.every((hour) => value.hours.includes(hour))
                ),
                'LOAD_OBS_LATENCY_HOUR'
            );
        for (const row of after.dimensions)
            if (!allowed.has(key(row))) {
                const initial = before.dimensions.find(
                    (value) => key(value) === key(row)
                );
                need(initial && same(initial, row), 'LOAD_OBS_LATENCY_EXTRA');
            }
        const pairs = [];
        for (const [organization, organizationId] of Object.entries(orgs))
            for (const mode of MODES) {
                const count = trace.requests.filter(
                        (row) =>
                            row.organization === organization &&
                            row.mode === mode
                    ).length,
                    marker =
                        before.markers.find(
                            (row) => row.organizationId === organizationId
                        )?.knownGapReports ?? '0',
                    initial =
                        before.dimensions.find(
                            (row) =>
                                key(row) ===
                                key(empty(organizationId, mode, marker))
                        ) ?? empty(organizationId, mode, marker),
                    final =
                        after.dimensions.find(
                            (row) => key(row) === key(initial)
                        ) ?? empty(organizationId, mode, marker);
                const bound = reconcileCohort(
                    initial,
                    final,
                    count,
                    mode !== 'LEXICAL'
                );
                pairs.push({ organization, mode, ...bound });
            }
        return {
            status: pairs.some((pair) => pair.decision === 'FAIL')
                ? 'FAIL'
                : pairs.some((pair) => pair.decision === 'INCONCLUSIVE')
                  ? 'INCONCLUSIVE'
                  : 'PASS',
            pairs,
            beforeSha256: digest(before),
            afterSha256: digest(after),
            evidence:
                'EXCLUSIVE_MATCHED_BEST_EFFORT_SEARCH_COHORT_NOT_FLUSH_ACK',
        };
    } catch {
        return {
            status: 'UNMEASURED',
            pairs: [],
            beforeSha256: digest(before),
            afterSha256: digest(after),
            reason: 'INCOMPLETE_OR_CONTRADICTORY_COHORT',
        };
    }
}
/** Guarded load binding; no quality validator or namespace is admitted. */
export async function createLoadTrafficLatencyRuntime({
    state,
    fixture,
    statePath,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    validateIdentity(state, fixture);
    const admit = () => loadObserverGuard({ state, statePath });
    admit();
    const require = createRequire(
            path.resolve(
                path.dirname(fileURLToPath(import.meta.url)),
                '../../../apps/api/package.json'
            )
        ),
        { Client } = require('pg');
    const producerIdentitySha256 = digest({
        runId: state.runId,
        commit: state.commit,
        processes: state.processes,
        resources: Object.fromEntries(
            Object.entries(state.resources).map(([name, row]) => [
                name,
                {
                    id: row.id,
                    imageId: row.imageId,
                    volumeIdentity: row.volumeIdentity,
                },
            ])
        ),
    });
    return {
        async snapshot() {
            admit();
            const client = new Client({
                connectionString: state.environment.DATABASE_URL,
                connectionTimeoutMillis: 5000,
                query_timeout: 10000,
            });
            try {
                await client.connect();
                return await readLoadSearchSnapshot(client, {
                    state,
                    fixture,
                    producerIdentitySha256,
                });
            } catch (error) {
                if (error instanceof LoadObservationError) throw error;
                throw new LoadObservationError('LOAD_OBS_LATENCY_READ');
            } finally {
                await client.end().catch(() => {});
            }
        },
    };
}
