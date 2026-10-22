import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { fixture as f } from './fixtures';
import {
    createParentFixture,
    parentText,
    type ParentStrategy,
} from './parent-fixtures';

export const syncManageGrant = {
    read: true,
    manageDocuments: true,
    administer: false,
};
export const syncReadGrant = {
    read: true,
    manageDocuments: false,
    administer: false,
};

/** Three same-organization actors remain distinct: owner/controller A, document manager B, library-only writer W. */
export async function createSyncFixture(label: string) {
    const fixture = await createParentFixture(`Synchronization ${label}`, true);
    try {
        const writerRole = `sync-library-${randomUUID().slice(0, 8)}`;
        const managerRole = `sync-manager-${randomUUID().slice(0, 8)}`;
        for (const [role, permission] of [
            [
                writerRole,
                {
                    dashboard: ['read'],
                    ragLibrary: ['read', 'readAll', 'write'],
                },
            ],
            [
                managerRole,
                {
                    dashboard: ['read'],
                    ragCollection: ['read', 'manageDocuments'],
                    ragLibrary: ['read'],
                },
            ],
        ] as const)
            await f.owner.post('organization/create-role', {
                organizationId: f.org,
                role,
                permission,
            });
        await f.owner.post('organization/update-member-role', {
            organizationId: f.org,
            memberId: f.readerMember,
            role: writerRole,
        });
        await f.owner.post('organization/update-member-role', {
            organizationId: f.org,
            memberId: f.managerMember,
            role: managerRole,
        });
        return { ...fixture, writerRole, managerRole };
    } catch (error) {
        await fixture.close();
        throw error;
    }
}
export type SyncFixture = Awaited<ReturnType<typeof createSyncFixture>>;

/** Advance only owned pending task scheduling; source, lease, counters and completion remain real worker state. */
export async function scanSync(
    fixture: SyncFixture,
    generationIds: string[],
    passes = 6
) {
    for (let pass = 0; pass < passes; pass++) {
        await prisma.indexTask.updateMany({
            where: {
                organizationId: fixture.organizationId,
                generationId: { in: generationIds },
                status: 'PENDING',
            },
            data: { availableAt: new Date(0) },
        });
        await fixture.scan(1);
    }
}

/**
 * Activation rotates globally through ten live generations per scan. Prior catalog
 * journeys deliberately retain their real rows, so a fixed local tick count does
 * not establish activation. Wait through bounded real pages without mutating any
 * generation timestamps, pointers, publication or task completion.
 */
export async function waitSyncActive(
    fixture: SyncFixture,
    generationId: string
) {
    const live = await prisma.indexGeneration.count({
        where: {
            status: { in: ['BUILDING', 'ACTIVE'] },
            collection: { deletedAt: null },
        },
    });
    const passes = 12 + Math.ceil(live / 10) * 2;
    for (let pass = 0; pass < passes; pass++) {
        await scanSync(fixture, [generationId], 1);
        const generation = await prisma.indexGeneration.findUniqueOrThrow({
            where: { id: generationId },
        });
        if (generation.status === 'ACTIVE') return;
    }
    const tasks = await prisma.indexTask.findMany({
        where: { generationId },
        select: { kind: true, status: true, stage: true, errorCode: true },
        orderBy: { createdAt: 'desc' },
        take: 20,
    });
    assert.fail(
        `The owned generation did not activate after ${passes} bounded scans: ${JSON.stringify(tasks)}`
    );
}

/** Use actual library replacement and extraction: a collection management grant is never added to the writer. */
export async function replaceSyncSource(
    fixture: SyncFixture,
    documentId: string,
    text: string
) {
    const previous = await prisma.documentVersion.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, documentId },
        orderBy: { version: 'desc' },
    });
    const result = await f.reader.rag.documents.replace({
        id: documentId,
        expectedVersionId: previous.id,
        requestId: randomUUID(),
        file: new File([text], `sync-v${previous.version + 1}.txt`),
        retentionDays: 0,
    });
    await processDocumentIngestions(prisma);
    const version = await prisma.documentVersion.findFirstOrThrow({
        where: { organizationId: fixture.organizationId, documentId },
        orderBy: { version: 'desc' },
        include: { ingestion: true },
    });
    assert.equal(result.id, documentId);
    assert.equal(version.status, 'READY');
    assert.equal(version.ingestion?.requestedBy, f.users[2]);
    return version;
}

/** Resolve the currently desired task rather than accidentally selecting a completed historical candidate. */
export async function currentSyncTask(
    generationId: string,
    documentId: string
) {
    const desired = await prisma.generationDocument.findUniqueOrThrow({
        where: { ['generationId_documentId']: { generationId, documentId } },
    });
    return prisma.indexTask.findFirstOrThrow({
        where: {
            organizationId: f.org,
            generationId,
            kind: 'INDEX_DOCUMENT',
            indexedDocument: {
                documentId,
                buildRevision: desired.buildRevision,
            },
        },
    });
}

export async function assertSyncVersion(
    generationId: string,
    documentId: string,
    version: number
) {
    const desired = await prisma.generationDocument.findUniqueOrThrow({
        where: { ['generationId_documentId']: { generationId, documentId } },
        include: {
            publishedIndexedDocument: { include: { sourceVersion: true } },
        },
    });
    assert(desired.publishedIndexedDocument);
    assert.equal(
        desired.publishedIndexedDocument.sourceVersion.version,
        version
    );
    assert.equal(desired.publishedIndexedDocument.status, 'PUBLISHED');
    return desired.publishedIndexedDocument;
}

/** Start one immutable parent-enabled profile with a deliberately explicit controller. */
export async function startSyncCollection(
    fixture: SyncFixture,
    input: {
        name: string;
        strategy?: ParentStrategy;
        controller?: 'owner' | 'manager';
        documentId?: string;
        text?: string;
        scan?: boolean;
    }
) {
    const collection = await fixture.collection(
        input.name,
        input.strategy ?? 'TOKEN_WINDOW'
    );
    if (input.controller === 'manager')
        await f.owner.rag.collections.setGrant({
            id: collection.id,
            target: { type: 'member', id: f.managerMember },
            permissions: syncManageGrant,
        });
    let documentId = input.documentId;
    if (documentId)
        await f.owner.rag.documents.setCollection({
            id: documentId,
            collectionId: collection.id,
            attached: true,
        });
    else
        documentId = (
            await fixture.upload(
                input.text ?? parentText,
                `${randomUUID()}.txt`,
                collection.id
            )
        ).id;
    const actor = input.controller === 'manager' ? f.manager : f.owner;
    const started = await actor.rag.indexing.start({
        collectionId: collection.id,
        expectedRevision: 1,
        requestId: randomUUID(),
    });
    const generation = await prisma.indexGeneration.findUniqueOrThrow({
        where: { id: started.generationId },
    });
    assert.equal(
        generation.authorityUserId,
        input.controller === 'manager' ? f.users[3] : f.users[0]
    );
    if (input.scan !== false) {
        await waitSyncActive(fixture, generation.id);
        assert.equal(
            (await f.owner.rag.indexing.status({ collectionId: collection.id }))
                .active?.id,
            generation.id
        );
        await assertSyncVersion(generation.id, documentId, 1);
    }
    return { collection, documentId, generationId: generation.id };
}

export async function assertSyncDenied(
    promise: Promise<unknown>,
    expected = ['FORBIDDEN', 'NOT_FOUND']
) {
    await assert.rejects(promise, (error: unknown) => {
        assert(error && typeof error === 'object' && 'code' in error);
        assert(
            expected.includes(String(error.code)),
            'A typed safe denial is required.'
        );
        return true;
    });
}
