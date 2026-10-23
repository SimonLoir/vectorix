import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestContext } from 'node:test';
import { Pool } from 'pg';
import { prisma } from '@repo/db';
import { RagTelemetryRecorder } from '@routers/rag/telemetry';
import { app } from '../app';
import { fixture as f, rpc } from './fixtures';
import { assertSyncDenied } from './sync-authority-fixtures';
import { createTelemetryFixture } from './telemetry-fixtures';

/** Technical summaries require session quota authority, never a content grant or merely possession of a tenant ID. */
export async function telemetryAccessTests(t: TestContext) {
    await t.test(
        'telemetry respects tenant context, current custom roles, session-only keys and suspension without granting source access',
        async () => {
            const fixture = await createTelemetryFixture(
                'Admission boundaries'
            );
            try {
                const foreignBefore = await f.other.rag.telemetry.summary({});
                const recorder = new RagTelemetryRecorder(prisma);
                recorder.observe(
                    {
                        organizationId: f.org,
                        workload: 'EXTRACTION',
                        provider: 'NONE',
                    },
                    { recordedStarts: 53n }
                );
                await recorder.flush();
                const manager = await f.manager.rag.telemetry.summary({});
                assert.equal(manager.totals?.recordedStarts, '53');
                const foreignAfter = await f.other.rag.telemetry.summary({});
                assert.deepEqual(foreignAfter.totals, foreignBefore.totals);
                assert(!JSON.stringify(foreignAfter).includes(f.org));
                await f.owner.post('organization/update-role', {
                    organizationId: f.org,
                    roleName: fixture.managerRole,
                    data: { permission: { dashboard: ['read'] } },
                });
                await assertSyncDenied(f.manager.rag.telemetry.summary({}), [
                    'FORBIDDEN',
                ]);
                await f.owner.post('organization/update-role', {
                    organizationId: f.org,
                    roleName: fixture.managerRole,
                    data: {
                        permission: { dashboard: ['read'], ragQuota: ['read'] },
                    },
                });
                assert.equal(
                    (await f.manager.rag.telemetry.summary({})).totals
                        ?.recordedStarts,
                    '53'
                );
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Telemetry session boundary',
                        permissions: { ragCollection: ['read'] },
                        collectionScopes: [],
                    });
                const api = rpc(() => ({ 'x-api-key': key.key }));
                await assertSyncDenied(api.admin.rag.telemetry.summary({}), [
                    'FORBIDDEN',
                ]);
                const pinned = rpc(() => ({
                    ...f.other.headers(),
                    'Vectorix-Expected-Organization-Id': f.org,
                }));
                await assertSyncDenied(pinned.admin.rag.telemetry.summary({}), [
                    'CONFLICT',
                ]);
                await prisma.organization.update({
                    where: { id: f.org },
                    data: { isActive: false },
                });
                try {
                    await assertSyncDenied(f.owner.rag.telemetry.summary({}), [
                        'FORBIDDEN',
                    ]);
                } finally {
                    await prisma.organization.update({
                        where: { id: f.org },
                        data: { isActive: true },
                    });
                }
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'superadmin technical summaries, worker evidence and RPC/REST/spec metadata expose no content identifiers',
        async () => {
            const fixture = await createTelemetryFixture(
                'Admin and transports'
            );
            const original = await prisma.user.findUniqueOrThrow({
                where: { id: f.users[0] },
            });
            try {
                await prisma.user.update({
                    where: { id: original.id },
                    data: { isSuperAdmin: true },
                });
                const org =
                    await f.owner.client.superadmin.organizations.getTelemetry({
                        organizationId: f.org,
                    });
                assert.equal(org.state, 'NOT_TRACKED');
                for (const privateValue of [
                    f.org,
                    f.users[0]!,
                    fixture.managerRole,
                ])
                    assert(!JSON.stringify(org).includes(privateValue));
                await assertSyncDenied(
                    f.manager.client.superadmin.organizations.getTelemetry({
                        organizationId: f.org,
                    }),
                    ['FORBIDDEN']
                );
                await assertSyncDenied(
                    f.owner.client.superadmin.organizations.getTelemetry({
                        organizationId: randomUUID(),
                    }),
                    ['NOT_FOUND']
                );
                await assertSyncDenied(
                    f.manager.client.superadmin.getWorkerObservations({}),
                    ['FORBIDDEN']
                );
                const recorder = new RagTelemetryRecorder(prisma);
                const scan = recorder.startScan('INDEXING');
                recorder.heartbeat('INDEXING');
                await recorder.flush();
                scan.finish('THREW', 'SCAN_FAILED');
                await recorder.flush();
                recorder.heartbeat('INDEXING');
                await recorder.flush();
                const worker =
                    await f.owner.client.superadmin.getWorkerObservations({});
                assert.equal(worker.items.length, 3);
                const indexing = worker.items.find(
                    (row) => row.lane === 'INDEXING'
                );
                assert(
                    indexing?.lastScanFinishObservedAt &&
                        indexing.lastFinishedScanStartObservedAt
                );
                assert.equal(indexing.state, 'RECENT');
                assert.equal(indexing.lastScanOutcome, 'THREW');
                assert.equal(indexing.lastSafeFailure, 'SCAN_FAILED');
                assert(
                    indexing.lastFinishedScanStartObservedAt <=
                        indexing.lastScanFinishObservedAt
                );
                for (const path of [
                    '/api/v1/admin/rag/telemetry?window=24H',
                    `/api/v1/superadmin/organizations/${f.org}/telemetry?window=7D`,
                    '/api/v1/superadmin/worker-observations',
                ]) {
                    const response = await app.request(path, {
                        headers: f.owner.headers(),
                    });
                    assert.equal(response.status, 200);
                    assert.equal(
                        response.headers.get('Vectorix-API-Revision'),
                        '19'
                    );
                    const encoded = await response.text();
                    assert(!encoded.includes(f.org));
                    assert(Buffer.byteLength(encoded) < 2_097_152);
                }
                const spec: unknown = await (
                    await app.request('/spec/v1.json')
                ).json();
                assert(
                    spec &&
                        typeof spec === 'object' &&
                        'info' in spec &&
                        spec.info &&
                        typeof spec.info === 'object' &&
                        'version' in spec.info
                );
                assert.equal(spec.info.version, '1.19.0');
                assert(
                    'paths' in spec &&
                        spec.paths &&
                        typeof spec.paths === 'object'
                );
                for (const path of [
                    '/admin/rag/telemetry',
                    '/superadmin/organizations/{organizationId}/telemetry',
                    '/superadmin/worker-observations',
                ])
                    assert(path in spec.paths);
                for (const query of [
                    'window=365D',
                    'window=24H&organizationId=foreign',
                ]) {
                    const response = await app.request(
                        `/api/v1/admin/rag/telemetry?${query}`,
                        { headers: f.owner.headers() }
                    );
                    assert.equal(response.status, 400);
                }
            } finally {
                await prisma.user.update({
                    where: { id: original.id },
                    data: { isSuperAdmin: original.isSuperAdmin },
                });
                await fixture.close();
            }
        }
    );

    await t.test(
        'a captured telemetry read cannot return after current quota permission is revoked',
        async () => {
            const fixture = await createTelemetryFixture(
                'Final current-role fence'
            );
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                max: 3,
            });
            let pending: Promise<unknown> | undefined;
            try {
                assert(
                    new URL(process.env.DATABASE_URL!).pathname.endsWith(
                        '_test'
                    )
                );
                const lock = await pool.connect();
                try {
                    await lock.query('BEGIN');
                    const blocker = (
                        await lock.query<{ pid: number }>(
                            'SELECT pg_backend_pid() AS pid'
                        )
                    ).rows[0]!.pid;
                    await lock.query(
                        'LOCK TABLE "RagOperationalHour" IN ACCESS EXCLUSIVE MODE'
                    );
                    pending = f.manager.rag.telemetry.summary({}).then(
                        () => null,
                        (error: unknown) => error
                    );
                    let observed = false;
                    for (let attempt = 0; attempt < 200; attempt++) {
                        const rows = await pool.query(
                            'SELECT activity.pid FROM pg_stat_activity activity JOIN pg_locks waiting ON waiting.pid=activity.pid AND NOT waiting.granted WHERE activity.datname=current_database() AND $1=ANY(pg_blocking_pids(activity.pid)) AND waiting.locktype=$2 AND waiting.relation=to_regclass($3)',
                            [blocker, 'relation', 'public."RagOperationalHour"']
                        );
                        if (rows.rowCount) {
                            observed = true;
                            break;
                        }
                        await delay(10);
                    }
                    assert(
                        observed,
                        'Actual captured telemetry SQL did not reach its relation barrier.'
                    );
                    await f.owner.post('organization/update-role', {
                        organizationId: f.org,
                        roleName: fixture.managerRole,
                        data: { permission: { dashboard: ['read'] } },
                    });
                } finally {
                    await lock.query('ROLLBACK');
                    lock.release();
                }
                const error = await pending;
                assert(error && typeof error === 'object' && 'code' in error);
                assert.equal(error.code, 'FORBIDDEN');
            } finally {
                await pending;
                await pool.end();
                await fixture.close();
            }
        }
    );
}
