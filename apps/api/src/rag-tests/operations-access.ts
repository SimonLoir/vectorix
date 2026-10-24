import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { app } from '../app';
import { fixture as f, rpc } from './fixtures';
import {
    createOperationsFixture,
    operationCounts,
} from './operations-fixtures';
import {
    assertSyncDenied,
    startSyncCollection,
    syncReadGrant,
} from './sync-authority-fixtures';

/** Filters and paging operate on visible current work, while explicit quota-read totals cover the whole authenticated organization. */
export async function operationsAccessTests(t: TestContext) {
    await t.test(
        'operations filter current collection grants before stable paging and keep organization totals separate from visible totals',
        async () => {
            const fixture = await createOperationsFixture(
                'Bounded grants and pages'
            );
            try {
                const entries: Awaited<
                    ReturnType<typeof startSyncCollection>
                >[] = [];
                for (const name of [
                    'Alpha',
                    'Hidden Bravo',
                    'Charlie',
                    'Hidden Delta',
                ])
                    entries.push(
                        await startSyncCollection(fixture, {
                            name: `Ops pages ${name}`,
                            scan: false,
                            ...(entries[0]
                                ? { documentId: entries[0].documentId }
                                : {}),
                        })
                    );
                const group = await f.owner.rag.groups.create({
                    name: 'Operations visible collection group',
                });
                await f.owner.rag.groups.addMember({
                    id: group.id,
                    memberId: f.managerMember,
                });
                for (const entry of [entries[0]!, entries[2]!])
                    await f.owner.rag.collections.setGrant({
                        id: entry.collection.id,
                        target: { type: 'group', id: group.id },
                        permissions: syncReadGrant,
                    });
                const all = await f.owner.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert.equal(operationCounts(all, 'INDEXING').total, 8);
                assert.equal(all.visibleTotal, 8);
                const first = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    query: 'Ops pages',
                    limit: 2,
                    offset: 0,
                });
                const second = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    query: 'Ops pages',
                    limit: 2,
                    offset: 2,
                });
                assert.deepEqual(first.counts, all.counts);
                assert.equal(first.visibleTotal, 4);
                assert.equal(second.visibleTotal, 4);
                assert.equal(first.items.length, 2);
                assert.equal(second.items.length, 2);
                const combined = [...first.items, ...second.items];
                assert.equal(
                    new Set(
                        combined.map(
                            (row) => `${row.category}:${row.kind}:${row.id}`
                        )
                    ).size,
                    4
                );
                const allowed = new Set([
                    entries[0]!.collection.id,
                    entries[2]!.collection.id,
                ]);
                assert(
                    combined.every(
                        (row) =>
                            row.target.type === 'COLLECTION' &&
                            allowed.has(row.target.id) &&
                            !row.name.includes('Hidden')
                    )
                );
                const repeated = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    query: 'Ops pages',
                    limit: 2,
                    offset: 0,
                });
                assert.deepEqual(
                    repeated.items.map((row) => row.id),
                    first.items.map((row) => row.id)
                );
                const filtered = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    state: 'DUE',
                    query: 'Alpha',
                    limit: 100,
                });
                assert.equal(filtered.visibleTotal, 2);
                assert(
                    filtered.items.every(
                        (row) => row.target.id === entries[0]!.collection.id
                    )
                );
                assert.deepEqual(filtered.counts, all.counts);
                for (const query of ['%', '_', 'Hidden'])
                    assert.equal(
                        (
                            await f.manager.rag.operations.overview({
                                category: 'INDEXING',
                                query,
                            })
                        ).visibleTotal,
                        0
                    );
                await f.owner.rag.groups.removeMember({
                    id: group.id,
                    memberId: f.managerMember,
                });
                const revoked = await f.manager.rag.operations.overview({
                    category: 'INDEXING',
                    limit: 100,
                });
                assert.deepEqual(revoked.counts, all.counts);
                assert.equal(revoked.visibleTotal, 0);
                assert.deepEqual(revoked.items, []);
                for (const entry of entries)
                    await assertSyncDenied(
                        f.manager.rag.indexing.status({
                            collectionId: entry.collection.id,
                        })
                    );
            } finally {
                await fixture.close();
            }
        }
    );

    await t.test(
        'quota-only sessions, library-only managers, role changes, scoped keys, suspension and foreign sessions preserve operations detail boundaries',
        async () => {
            const fixture = await createOperationsFixture(
                'Session and tenant scope'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: `Private operations ${randomUUID()}`,
                    scan: false,
                });
                const library = await f.reader.rag.operations.overview({
                    category: 'INDEXING',
                });
                assert.equal(operationCounts(library, 'INDEXING').total, 2);
                assert.equal(library.visibleTotal, 0);
                assert.equal(
                    JSON.stringify(library).includes(entry.collection.id),
                    false
                );
                await f.owner.post('organization/update-role', {
                    organizationId: f.org,
                    roleName: fixture.writerRole,
                    data: { permission: { ragQuota: ['read'] } },
                });
                const quotaOnly = await f.reader.rag.operations.overview({
                    category: 'INDEXING',
                });
                assert.equal(operationCounts(quotaOnly, 'INDEXING').total, 2);
                assert.equal(quotaOnly.visibleTotal, 0);
                assert.deepEqual(quotaOnly.items, []);
                await f.owner.post('organization/update-role', {
                    organizationId: f.org,
                    roleName: fixture.writerRole,
                    data: { permission: { dashboard: ['read'] } },
                });
                await assertSyncDenied(f.reader.rag.operations.overview({}), [
                    'FORBIDDEN',
                ]);
                const key =
                    await f.owner.client.admin.organization.apiKeys.create({
                        name: 'Operations read key',
                        permissions: {
                            ragCollection: ['read'],
                            ragLibrary: ['read'],
                        },
                        collectionScopes: [
                            {
                                collectionId: entry.collection.id,
                                read: true,
                                manageDocuments: false,
                            },
                        ],
                    });
                const client = rpc(() => ({ 'x-api-key': key.key }));
                assert.equal(
                    (
                        await client.admin.rag.collections.get({
                            id: entry.collection.id,
                        })
                    ).id,
                    entry.collection.id
                );
                await assertSyncDenied(
                    client.admin.rag.operations.overview({}),
                    ['FORBIDDEN']
                );
                await assertSyncDenied(
                    client.superadmin.organizations.getOperations({
                        organizationId: f.org,
                    }),
                    ['FORBIDDEN']
                );
                const foreign = await f.other.rag.operations.overview({
                    category: 'INDEXING',
                    query: entry.collection.name,
                    limit: 100,
                });
                assert.equal(foreign.visibleTotal, 0);
                assert.equal(
                    JSON.stringify(foreign).includes(entry.generationId),
                    false
                );
                await assertSyncDenied(
                    f.other.rag.indexing.status({
                        collectionId: entry.collection.id,
                    })
                );
                const pinned = rpc(() => ({
                    ...f.owner.headers(),
                    'Vectorix-Expected-Organization-Id': f.otherOrg,
                }));
                await assertSyncDenied(
                    pinned.admin.rag.operations.overview({}),
                    ['CONFLICT']
                );
                await prisma.organization.update({
                    where: { id: f.org },
                    data: { isActive: false },
                });
                try {
                    await assertSyncDenied(
                        f.owner.rag.operations.overview({}),
                        ['FORBIDDEN']
                    );
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
        'superadmin exposes technical organization aggregates and compatible REST metadata without content or recovery authority',
        async () => {
            const user = await prisma.user.findUniqueOrThrow({
                where: { id: f.users[0] },
            });
            const fixture = await createOperationsFixture(
                'Admin technical overview'
            );
            try {
                const entry = await startSyncCollection(fixture, {
                    name: 'Admin must not read this source',
                });
                const search = await f.owner.rag.indexing.search({
                    collectionId: entry.collection.id,
                    query: 'forest',
                    strategy: 'HYBRID',
                    topK: 3,
                    filters: {},
                });
                assert(search.results[0]);
                await f.owner.rag.collections.setGrant({
                    id: entry.collection.id,
                    target: { type: 'member', id: f.ownerMember },
                    permissions: {
                        read: false,
                        manageDocuments: false,
                        administer: true,
                    },
                });
                await prisma.user.update({
                    where: { id: user.id },
                    data: { isSuperAdmin: true },
                });
                const view =
                    await f.owner.client.superadmin.organizations.getOperations(
                        { organizationId: f.org }
                    );
                assert.deepEqual(Object.keys(view).toSorted(), [
                    'counts',
                    'observedAt',
                ]);
                operationCounts(view, 'INDEXING');
                assert.equal(
                    JSON.stringify(view).includes(entry.collection.id),
                    false
                );
                assert.equal(
                    JSON.stringify(view).includes(entry.documentId),
                    false
                );
                await assertSyncDenied(
                    f.owner.rag.indexing.sourcePreview({
                        collectionId: entry.collection.id,
                        receipt: search.results[0].source.receipt,
                    })
                );
                await assertSyncDenied(
                    f.manager.client.superadmin.organizations.getOperations({
                        organizationId: f.org,
                    }),
                    ['FORBIDDEN']
                );
                await assertSyncDenied(
                    f.owner.client.superadmin.organizations.getOperations({
                        organizationId: randomUUID(),
                    }),
                    ['NOT_FOUND']
                );
                const response = await app.request(
                    `/api/v1/superadmin/organizations/${f.org}/operations`,
                    { headers: f.owner.headers() }
                );
                assert.equal(response.status, 200);
                assert.equal(
                    response.headers.get('Vectorix-API-Revision'),
                    '20'
                );
                const body: unknown = await response.json();
                assert(body && typeof body === 'object');
                assert.deepEqual(Object.keys(body).toSorted(), [
                    'counts',
                    'observedAt',
                ]);
                const ordinary = await app.request(
                    '/api/v1/admin/rag/operations?category=INDEXING&limit=2',
                    { headers: f.owner.headers() }
                );
                assert.equal(ordinary.status, 200);
                assert.equal(
                    ordinary.headers.get('Vectorix-API-Revision'),
                    '20'
                );
                for (const input of [
                    { limit: 101 },
                    { limit: 0 },
                    { offset: -1 },
                    { offset: 100_001 },
                    { query: 'x'.repeat(201) },
                ])
                    await assertSyncDenied(
                        f.owner.rag.operations.overview(input),
                        ['BAD_REQUEST']
                    );
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
                assert.equal(spec.info.version, '1.21.0');
                assert(
                    'paths' in spec &&
                        spec.paths &&
                        typeof spec.paths === 'object'
                );
                assert('/admin/rag/operations' in spec.paths);
                assert(
                    '/superadmin/organizations/{organizationId}/operations' in
                        spec.paths
                );
                await prisma.user.update({
                    where: { id: user.id },
                    data: { isSuperAdmin: false },
                });
                await assertSyncDenied(
                    f.owner.client.superadmin.organizations.getOperations({
                        organizationId: f.org,
                    }),
                    ['FORBIDDEN']
                );
            } finally {
                await prisma.user.update({
                    where: { id: user.id },
                    data: { isSuperAdmin: user.isSuperAdmin },
                });
                await fixture.close();
            }
        }
    );
}
