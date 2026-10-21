import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { fixture as f, profile, readGrant, rpc } from './fixtures';

export async function accessTests(t: TestContext) {
    const a = await f.owner.rag.collections.create({
        name: 'Access alpha',
        profile,
    });
    const b = await f.owner.rag.collections.create({
        name: 'Access beta',
        profile,
    });
    const foreign = await f.other.rag.collections.create({
        name: 'Foreign collection',
        profile,
    });
    const group = await f.owner.rag.groups.create({ name: 'Alpha readers' });
    const secondGroup = await f.owner.rag.groups.create({
        name: 'Other readers',
    });
    const foreignGroup = await f.other.rag.groups.create({
        name: 'Foreign group',
    });
    const document = await prisma.document.create({
        data: {
            organizationId: f.org,
            name: 'Shared document',
            status: 'READY',
        },
    });
    await prisma.collectionDocument.createMany({
        data: [a, b].map((collection) => ({
            organizationId: f.org,
            collectionId: collection.id,
            documentId: document.id,
        })),
    });
    const privateDoc = await prisma.document.create({
        data: {
            organizationId: f.org,
            name: 'Unlinked document',
            status: 'READY',
        },
    });
    const foreignDoc = await prisma.document.create({
        data: {
            organizationId: f.otherOrg,
            name: 'Foreign document',
            status: 'READY',
        },
    });

    await t.test(
        'organization boundaries hold for lists, direct IDs, relations, and database foreign keys',
        async () => {
            await assert.rejects(f.other.rag.collections.get({ id: a.id }), {
                code: 'NOT_FOUND',
            });
            await assert.rejects(
                f.other.rag.collections.update({
                    id: a.id,
                    expectedRevision: 1,
                    name: 'Foreign write',
                    description: '',
                    profile,
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.other.rag.collections.delete({
                    id: a.id,
                    expectedRevision: 1,
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.groups.addMember({
                    id: group.id,
                    memberId: f.otherMember,
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.groups.rename({
                    id: foreignGroup.id,
                    name: 'Foreign write',
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.groups.members({ id: foreignGroup.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.collections.setGrant({
                    id: a.id,
                    target: { type: 'group', id: foreignGroup.id },
                    permissions: readGrant,
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.collections.setGrant({
                    id: a.id,
                    target: { type: 'member', id: f.otherMember },
                    permissions: readGrant,
                }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(
                f.owner.rag.documents.get({ id: foreignDoc.id }),
                { code: 'NOT_FOUND' }
            );
            assert.equal((await f.other.rag.collections.list({})).total, 1);
            await assert.rejects(
                prisma.groupMember.create({
                    data: {
                        organizationId: f.org,
                        groupId: group.id,
                        memberId: f.otherMember,
                    },
                }),
                { code: 'P2003' }
            );
            await assert.rejects(
                prisma.collectionDocument.create({
                    data: {
                        organizationId: f.org,
                        collectionId: a.id,
                        documentId: foreignDoc.id,
                    },
                }),
                { code: 'P2003' }
            );
            await assert.rejects(
                prisma.collectionMemberGrant.create({
                    data: {
                        organizationId: f.org,
                        collectionId: foreign.id,
                        memberId: f.ownerMember,
                        read: true,
                    },
                }),
                { code: 'P2003' }
            );
        }
    );

    await t.test(
        'group grants are explicit, filtered before pagination, and revoke immediately',
        async () => {
            assert.equal((await f.reader.rag.collections.list({})).total, 0);
            await assert.rejects(
                f.reader.rag.documents.get({ id: document.id }),
                { code: 'NOT_FOUND' }
            );
            assert.equal(
                (await f.manager.rag.collections.get({ id: a.id })).permissions
                    .read,
                false
            );
            assert.equal(
                (await f.manager.rag.collections.get({ id: a.id })).permissions
                    .administer,
                true
            );
            assert.equal((await f.manager.rag.documents.list({})).total, 2);
            await f.owner.rag.groups.addMember({
                id: group.id,
                memberId: f.readerMember,
            });
            await f.owner.rag.groups.addMember({
                id: group.id,
                memberId: f.readerMember,
            });
            assert.equal(
                (await f.owner.rag.groups.members({ id: group.id })).total,
                1
            );
            await f.owner.rag.collections.setGrant({
                id: a.id,
                target: { type: 'group', id: group.id },
                permissions: readGrant,
            });
            await f.owner.rag.collections.setGrant({
                id: b.id,
                target: { type: 'group', id: secondGroup.id },
                permissions: readGrant,
            });
            const visible = await f.reader.rag.collections.list({ limit: 1 });
            assert.equal(visible.total, 1);
            assert.equal(visible.items[0]?.id, a.id);
            assert.equal(
                (await f.reader.rag.collections.list({ offset: 1, limit: 1 }))
                    .items.length,
                0
            );
            assert.equal(
                (await f.reader.rag.collections.list({ query: 'beta' })).total,
                0
            );
            assert.equal(
                (await f.reader.rag.documents.list({ limit: 1 })).total,
                1
            );
            assert.equal(
                (await f.reader.rag.documents.get({ id: document.id })).id,
                document.id
            );
            await assert.rejects(
                f.reader.rag.documents.get({ id: privateDoc.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(f.reader.rag.collections.get({ id: b.id }), {
                code: 'NOT_FOUND',
            });
            await assert.rejects(
                f.reader.rag.collections.setGrant({
                    id: a.id,
                    target: { type: 'member', id: f.readerMember },
                    permissions: readGrant,
                }),
                { code: 'FORBIDDEN' }
            );
            await f.owner.rag.groups.removeMember({
                id: group.id,
                memberId: f.readerMember,
            });
            await assert.rejects(
                f.reader.rag.documents.get({ id: document.id }),
                { code: 'NOT_FOUND' }
            );
            await f.owner.rag.groups.addMember({
                id: group.id,
                memberId: f.readerMember,
            });
            await f.owner.rag.collections.setGrant({
                id: b.id,
                target: { type: 'member', id: f.readerMember },
                permissions: readGrant,
            });
            assert.equal((await f.reader.rag.collections.list({})).total, 2);
        }
    );

    await t.test(
        'group membership cannot be used to bypass collection grant administration',
        async () => {
            await prisma.organizationRole.create({
                data: {
                    id: randomUUID(),
                    organizationId: f.org,
                    role: 'group-only',
                    permission: JSON.stringify({
                        ragGroups: ['read', 'manage'],
                    }),
                },
            });
            await prisma.member.update({
                where: { id: f.managerMember },
                data: { role: 'group-only' },
            });
            await assert.rejects(
                f.manager.rag.groups.addMember({
                    id: group.id,
                    memberId: f.managerMember,
                }),
                { code: 'FORBIDDEN' }
            );
            assert.equal((await f.manager.rag.collections.list({})).total, 0);
            await prisma.member.update({
                where: { id: f.managerMember },
                data: { role: 'admin' },
            });
        }
    );

    await t.test(
        "API keys intersect explicit scopes with their issuer's current role and collection grants",
        async () => {
            const issuerRole = {
                ragCollection: ['read'],
                ragLibrary: ['read'],
                apiKey: ['create', 'read', 'update'],
            };
            const role = await prisma.organizationRole.create({
                data: {
                    id: randomUUID(),
                    organizationId: f.org,
                    role: 'key-reader',
                    permission: JSON.stringify(issuerRole),
                },
            });
            await prisma.member.update({
                where: { id: f.readerMember },
                data: { role: role.role },
            });
            const permissions = {
                ragCollection: ['read'],
                ragLibrary: ['read'],
            };
            await assert.rejects(
                f.reader.client.admin.organization.apiKeys.create({
                    name: 'Foreign scope',
                    permissions,
                    collectionScopes: [
                        {
                            collectionId: foreign.id,
                            read: true,
                            manageDocuments: false,
                        },
                    ],
                }),
                { code: 'NOT_FOUND' }
            );
            const key = await f.reader.client.admin.organization.apiKeys.create(
                {
                    name: 'Alpha reader',
                    permissions,
                    collectionScopes: [
                        {
                            collectionId: a.id,
                            read: true,
                            manageDocuments: false,
                        },
                    ],
                }
            );
            await f.reader.client.admin.organization.apiKeys.updatePermissions({
                keyId: key.id,
                permissions,
            });
            assert.equal(
                await prisma.ragAuditLog.count({
                    where: {
                        organizationId: f.org,
                        targetId: key.id,
                        action: 'apiKey.permissions.update',
                    },
                }),
                1
            );
            const keyApi = rpc(() => ({ 'x-api-key': key.key }));
            assert.equal(
                (await keyApi.admin.rag.collections.list({})).total,
                1
            );
            assert.equal(
                (await keyApi.admin.rag.documents.get({ id: document.id })).id,
                document.id
            );
            await assert.rejects(
                keyApi.admin.rag.collections.get({ id: b.id }),
                { code: 'NOT_FOUND' }
            );
            await assert.rejects(keyApi.admin.rag.credentials.list({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(keyApi.admin.rag.groups.list({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(
                keyApi.admin.rag.collections.create({
                    name: 'Unauthorized',
                    profile,
                }),
                { code: 'FORBIDDEN' }
            );
            await assert.rejects(
                f.owner.client.admin.organization.apiKeys.updatePermissions({
                    keyId: key.id,
                    permissions,
                    collectionScopes: [
                        {
                            collectionId: b.id,
                            read: true,
                            manageDocuments: false,
                        },
                    ],
                }),
                { code: 'FORBIDDEN' }
            );
            assert.equal(
                (await keyApi.admin.rag.collections.list({})).total,
                1
            );
            await f.owner.rag.groups.removeMember({
                id: group.id,
                memberId: f.readerMember,
            });
            await assert.rejects(
                keyApi.admin.rag.collections.get({ id: a.id }),
                { code: 'NOT_FOUND' }
            );
            await f.owner.rag.groups.addMember({
                id: group.id,
                memberId: f.readerMember,
            });
            await prisma.organizationRole.update({
                where: { id: role.id },
                data: { permission: JSON.stringify({ apiKey: ['read'] }) },
            });
            assert.equal(
                (await keyApi.admin.rag.collections.list({})).total,
                0
            );
            await assert.rejects(keyApi.admin.rag.documents.list({}), {
                code: 'FORBIDDEN',
            });
            await prisma.organizationRole.update({
                where: { id: role.id },
                data: { permission: JSON.stringify(issuerRole) },
            });
            await prisma.organization.update({
                where: { id: f.org },
                data: { isActive: false },
            });
            await assert.rejects(keyApi.admin.rag.collections.list({}));
            await assert.rejects(f.owner.rag.collections.list({}));
            await prisma.organization.update({
                where: { id: f.org },
                data: { isActive: true },
            });
            await prisma.apikey.update({
                where: { id: key.id },
                data: { enabled: false },
            });
            await assert.rejects(keyApi.admin.rag.collections.list({}));
            await prisma.apikey.update({
                where: { id: key.id },
                data: { enabled: true },
            });
            // An old key has no recoverable issuer. Adding RAG permissions never binds it automatically.
            const old = await f.owner.client.admin.organization.apiKeys.create({
                name: 'No legacy upgrade',
                permissions,
            });
            await prisma.apiKeyPrincipal.delete({ where: { keyId: old.id } });
            const oldApi = rpc(() => ({ 'x-api-key': old.key }));
            await assert.rejects(oldApi.admin.rag.collections.list({}), {
                code: 'FORBIDDEN',
            });
            await assert.rejects(
                f.owner.client.admin.organization.apiKeys.updatePermissions({
                    keyId: old.id,
                    permissions,
                    collectionScopes: [
                        {
                            collectionId: a.id,
                            read: true,
                            manageDocuments: false,
                        },
                    ],
                }),
                { code: 'CONFLICT' }
            );
            const list = await f.owner.client.admin.organization.apiKeys.list(
                {}
            );
            assert.ok(
                list.keys.some(
                    (item) =>
                        item.id === key.id &&
                        item.issuerMemberId === f.readerMember &&
                        item.collectionScopes.length === 1
                )
            );
            // Issuer deletion cascades the binding and scopes, even while the hashed key still exists.
            await prisma.member.delete({ where: { id: f.readerMember } });
            assert.equal(
                await prisma.apiKeyCollectionScope.count({
                    where: { keyId: key.id },
                }),
                0
            );
            await assert.rejects(keyApi.admin.rag.collections.list({}), {
                code: 'FORBIDDEN',
            });
            await prisma.member.create({
                data: {
                    id: f.readerMember,
                    organizationId: f.org,
                    userId: f.users[2]!,
                    role: 'member',
                    createdAt: new Date(),
                },
            });
            assert.equal((await f.reader.rag.collections.list({})).total, 0);
        }
    );

    await t.test(
        'deleting a collection revokes its grants but preserves shared library documents',
        async () => {
            await f.owner.rag.collections.setGrant({
                id: a.id,
                target: { type: 'member', id: f.readerMember },
                permissions: readGrant,
            });
            await f.owner.rag.collections.delete({
                id: a.id,
                expectedRevision: 1,
            });
            await assert.rejects(
                f.reader.rag.documents.get({ id: document.id }),
                { code: 'NOT_FOUND' }
            );
            await f.owner.rag.collections.setGrant({
                id: b.id,
                target: { type: 'member', id: f.readerMember },
                permissions: readGrant,
            });
            assert.equal(
                (await f.reader.rag.documents.get({ id: document.id })).id,
                document.id
            );
            assert.ok(
                await prisma.document.findUnique({ where: { id: document.id } })
            );
            await f.owner.rag.collections.removeGrant({
                id: b.id,
                target: { type: 'member', id: f.readerMember },
            });
            await assert.rejects(
                f.reader.rag.documents.get({ id: document.id }),
                { code: 'NOT_FOUND' }
            );
        }
    );
}
