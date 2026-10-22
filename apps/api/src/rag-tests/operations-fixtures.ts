import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { VectorixApiV1Outputs } from '@repo/api';
import { prisma } from '@repo/db';
import { fixture as f } from './fixtures';
import { createSyncFixture } from './sync-authority-fixtures';

export type OperationsView =
    VectorixApiV1Outputs['admin']['rag']['operations']['overview'];
export type OperationCategory = OperationsView['counts'][number]['category'];

/** All fixtures own a fresh organization and actual original objects; only explicitly marked claim dates/states are synthetic. */
export async function createOperationsFixture(label: string) {
    const fixture = await createSyncFixture(`Operations ${label}`);
    try {
        await f.owner.post('organization/update-role', {
            organizationId: f.org,
            roleName: fixture.writerRole,
            data: {
                permission: {
                    dashboard: ['read'],
                    ragLibrary: ['read', 'readAll', 'write'],
                    ragQuota: ['read'],
                },
            },
        });
        await f.owner.post('organization/update-role', {
            organizationId: f.org,
            roleName: fixture.managerRole,
            data: {
                permission: {
                    dashboard: ['read'],
                    ragCollection: ['read', 'manageDocuments'],
                    ragLibrary: ['read'],
                    ragQuota: ['read'],
                },
            },
        });
        return fixture;
    } catch (error) {
        await fixture.close();
        throw error;
    }
}

/** An accepted real upload is left for the production ingestion scanner, never marked complete by a fixture. */
export async function queueOperationsDocument(
    name: string,
    bytes:
        string | Uint8Array = 'Forêt française and English forest operations.'
) {
    const document = await f.owner.rag.documents.upload({
        requestId: randomUUID(),
        file: new File(
            [typeof bytes === 'string' ? bytes : Buffer.from(bytes)],
            name
        ),
    });
    const version = await prisma.documentVersion.findFirstOrThrow({
        where: { organizationId: f.org, documentId: document.id },
        orderBy: { version: 'desc' },
        include: { ingestion: true },
    });
    assert(version.ingestion);
    return { documentId: document.id, version };
}

/** Validate all three unrestricted count categories independently of the ACL-filtered selected list. */
export function operationCounts(
    view: Pick<OperationsView, 'counts'>,
    category: OperationCategory
) {
    assert.deepEqual(view.counts.map((row) => row.category).toSorted(), [
        'DOCUMENT_CLEANUP',
        'INDEXING',
        'INGESTION',
    ]);
    for (const row of view.counts)
        assert.equal(
            row.total,
            row.uploading +
                row.due +
                row.scheduled +
                row.leased +
                row.expired +
                row.failed
        );
    const row = view.counts.find((item) => item.category === category);
    assert(row);
    return row;
}
