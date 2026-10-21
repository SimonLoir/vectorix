import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { app } from '../app';
import { fixture as f, profile, readGrant, rpc } from './fixtures';

/** Dashboard reads use the same real transports and organization boundaries as catalog writes. */
export async function dashboardTests(t: TestContext) {
    const collection = await f.owner.rag.collections.create({
        name: 'Dashboard history',
        profile,
    });
    const group = await f.owner.rag.groups.create({
        name: 'Dashboard editors',
    });
    const foreignGroup = await f.other.rag.groups.create({
        name: 'Foreign dashboard editors',
    });
    await t.test(
        'revision history is bounded, immutable, sanitized, and revoked with collection access',
        async () => {
            await f.owner.rag.collections.update({
                id: collection.id,
                expectedRevision: 1,
                name: collection.name,
                description: '',
                profile: {
                    ...profile,
                    model: 'new-test-model',
                    dimensions: 1024,
                },
            });
            const history = await f.owner.rag.collections.revisions({
                id: collection.id,
                limit: 1,
            });
            assert.equal(history.total, 2);
            assert.equal(history.items.length, 1);
            assert.equal(history.items[0]?.revision, 2);
            assert.equal(history.items[0]?.configuration.dimensions, 1024);
            const previous = await f.owner.rag.collections.revisions({
                id: collection.id,
                offset: 1,
                limit: 1,
            });
            assert.equal(previous.items[0]?.configuration.dimensions, 768);
            for (const item of history.items) {
                assert.ok(!('endpoint' in item.configuration));
                assert.ok(!('organizationId' in item.configuration));
                assert.ok(!('apiKey' in item.configuration));
            }
            await assert.rejects(
                f.other.rag.collections.revisions({ id: collection.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.reader.rag.collections.revisions({ id: collection.id }),
                { code: 'NOT_FOUND' }
            );
            await f.owner.rag.collections.setGrant({
                id: collection.id,
                target: { type: 'member', id: f.readerMember },
                permissions: readGrant,
            });
            assert.equal(
                (
                    await f.reader.rag.collections.revisions({
                        id: collection.id,
                    })
                ).total,
                2
            );
            await f.owner.rag.collections.removeGrant({
                id: collection.id,
                target: { type: 'member', id: f.readerMember },
            });
            await assert.rejects(
                f.reader.rag.collections.revisions({ id: collection.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.collections.revisions({
                    id: collection.id,
                    limit: 101,
                }),
                { code: 'BAD_REQUEST' }
            );
            const response = await app.request(
                `/api/v1/admin/rag/collections/${collection.id}/revisions?limit=1`,
                { headers: f.owner.headers() }
            );
            assert.equal(response.status, 200, await response.clone().text());
            assert.equal((await response.json()).total, 2);
            const invalidPage = await app.request(
                `/api/v1/admin/rag/collections/${collection.id}/revisions?limit=101`,
                { headers: f.owner.headers() }
            );
            assert.equal(invalidPage.status, 400);
            const invalidNumber = await app.request(
                `/api/v1/admin/rag/collections/${collection.id}/revisions?limit=invalid`,
                { headers: f.owner.headers() }
            );
            assert.equal(invalidNumber.status, 400);
        }
    );
    await t.test(
        'editor candidates are searched and paginated in the authorized organization only',
        async () => {
            const page = await f.owner.rag.groups.memberCandidates({
                id: group.id,
                limit: 1,
            });
            assert.equal(page.items.length, 1);
            assert.equal(page.total, 3);
            const search = await f.owner.rag.groups.memberCandidates({
                id: group.id,
                query: 'RAG 2',
            });
            assert.deepEqual(search.items, [
                { id: f.readerMember, name: 'RAG 2' },
            ]);
            assert.ok(!JSON.stringify(page).includes('email'));
            await assert.rejects(
                f.owner.rag.groups.memberCandidates({ id: foreignGroup.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.reader.rag.groups.memberCandidates({ id: group.id }),
                { code: 'FORBIDDEN' }
            );
            const groups = await f.owner.rag.collections.grantCandidates({
                id: collection.id,
                type: 'group',
                query: 'dashboard',
            });
            assert.deepEqual(groups.items, [
                { id: group.id, name: group.name },
            ]);
            await assert.rejects(
                f.other.rag.collections.grantCandidates({
                    id: collection.id,
                    type: 'member',
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.reader.rag.collections.grantCandidates({
                    id: collection.id,
                    type: 'member',
                }),
                { code: 'FORBIDDEN' }
            );
            await f.owner.rag.collections.setGrant({
                id: collection.id,
                target: { type: 'group', id: group.id },
                permissions: readGrant,
            });
            const grants = await f.owner.rag.collections.grants({
                id: collection.id,
                query: group.name,
            });
            assert.equal(grants.items[0]?.name, group.name);
            const key = await f.owner.client.admin.organization.apiKeys.create({
                name: 'Dashboard history test',
                permissions: { ragCollection: ['read'] },
                collectionScopes: [
                    {
                        collectionId: collection.id,
                        read: true,
                        manageDocuments: false,
                    },
                ],
            });
            const api = rpc(() => ({ 'x-api-key': key.key }));
            assert.equal(
                (
                    await api.admin.rag.collections.revisions({
                        id: collection.id,
                    })
                ).total,
                2
            );
            await assert.rejects(
                api.admin.rag.collections.grantCandidates({
                    id: collection.id,
                    type: 'member',
                }),
                { code: 'FORBIDDEN' }
            );
        }
    );
    await t.test(
        'grant administrators and document managers can navigate metadata without obtaining read access',
        async () => {
            const role = await prisma.organizationRole.create({
                data: {
                    id: randomUUID(),
                    organizationId: f.org,
                    role: 'dashboard_grant_editor',
                    permission: JSON.stringify({
                        ragCollection: ['manageGrants'],
                    }),
                    createdAt: new Date(),
                },
            });
            await prisma.member.update({
                where: { id: f.readerMember },
                data: { role: role.role },
            });
            try {
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: {
                        read: false,
                        manageDocuments: false,
                        administer: true,
                    },
                });
                const metadata = await f.reader.rag.collections.get({
                    id: collection.id,
                });
                assert.equal(metadata.permissions.administer, true);
                assert.equal(metadata.permissions.read, false);
                assert.ok(
                    (await f.reader.rag.collections.list({})).items.some(
                        (item) => item.id === collection.id
                    )
                );
                assert.equal(
                    (
                        await f.reader.rag.collections.grantCandidates({
                            id: collection.id,
                            type: 'member',
                            query: 'RAG 2',
                        })
                    ).items[0]?.id,
                    f.readerMember
                );
                await assert.rejects(f.reader.rag.documents.list({}), {
                    code: 'FORBIDDEN',
                });
                await f.owner.rag.collections.removeGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                });
                await assert.rejects(
                    f.reader.rag.collections.get({ id: collection.id }),
                    { code: 'NOT_FOUND' }
                );
                await prisma.organizationRole.update({
                    where: { id: role.id },
                    data: {
                        permission: JSON.stringify({
                            ragCollection: ['manageDocuments'],
                        }),
                    },
                });
                await f.owner.rag.collections.setGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: {
                        read: false,
                        manageDocuments: true,
                        administer: false,
                    },
                });
                const documentManager = await f.reader.rag.collections.get({
                    id: collection.id,
                });
                assert.deepEqual(documentManager.permissions, {
                    read: false,
                    manageDocuments: true,
                    administer: false,
                });
                await assert.rejects(f.reader.rag.documents.list({}), {
                    code: 'FORBIDDEN',
                });
                await assert.rejects(
                    f.reader.rag.collections.grantCandidates({
                        id: collection.id,
                        type: 'member',
                    }),
                    { code: 'FORBIDDEN' }
                );
                await f.owner.rag.collections.removeGrant({
                    id: collection.id,
                    target: { type: 'member', id: f.readerMember },
                });
                await assert.rejects(
                    f.reader.rag.collections.get({ id: collection.id }),
                    { code: 'NOT_FOUND' }
                );
            } finally {
                await prisma.member.update({
                    where: { id: f.readerMember },
                    data: { role: 'member' },
                });
                await prisma.organizationRole.delete({
                    where: { id: role.id },
                });
            }
        }
    );
    await t.test(
        'effective quota reads remain restricted to platform administrators',
        async () => {
            await assert.rejects(
                f.owner.client.superadmin.organizations.getRagQuota({
                    organizationId: f.org,
                }),
                { code: 'FORBIDDEN' }
            );
            await prisma.user.update({
                where: { id: f.users[0] },
                data: { isSuperAdmin: true },
            });
            try {
                const quota =
                    await f.owner.client.superadmin.organizations.getRagQuota({
                        organizationId: f.org,
                    });
                assert.deepEqual(
                    quota.limits,
                    (await f.owner.rag.quota({})).limits
                );
                assert.equal(quota.overridden, false);
                await assert.rejects(
                    f.owner.client.superadmin.organizations.getRagQuota({
                        organizationId: randomUUID(),
                    }),
                    { code: 'NOT_FOUND' }
                );
            } finally {
                await prisma.user.update({
                    where: { id: f.users[0] },
                    data: { isSuperAdmin: false },
                });
            }
        }
    );
}
