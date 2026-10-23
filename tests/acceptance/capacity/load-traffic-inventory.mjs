/** Normal metadata reads preserve primary/reference membership while admitting only the declared tiny library growth. */
import { need, id, same } from './load-observer-core.mjs';
import { loadDescriptor } from './load-import-core.mjs';
export const STATIC_DRAFT_ONLY = true;
async function inventory(api, role, section, expected, check) {
    const ids = [];
    for (let offset = 0; offset < Math.max(1, expected.length); offset += 100) {
        check();
        const page = (
            await api.call(role, section + '.list', {
                offset,
                limit: 100,
                query: '',
            })
        ).value;
        check();
        need(
            page.total === expected.length &&
                page.items.length === Math.min(100, expected.length - offset),
            'LOAD_OBS_TRAFFIC_INVENTORY'
        );
        ids.push(...page.items.map((row) => row.id));
    }
    need(
        new Set(ids).size === expected.length &&
            ids.every((value) => expected.includes(value)),
        'LOAD_OBS_TRAFFIC_INVENTORY'
    );
}
/** Reuse immutable historical native receipts, never current organization totals; collection source tuples are exact. */
export async function verifyTrafficServingState({
    api,
    observer,
    fullReport,
    content,
    fixture,
    ingestion,
    check = () => {},
}) {
    const baseline = fullReport.baseline,
        bindings = {
            A: fullReport.documents.loadA,
            B: baseline.documents.referenceB,
        },
        collections = {
            A: fullReport.collections.primary,
            B: baseline.collections.referenceB,
        },
        descriptors = {
            A: content.manifest.documents.map(loadDescriptor),
            B: content.references.manifest.documents,
        };
    for (const organization of ['A', 'B']) {
        check();
        const role = organization === 'A' ? 'owner' : 'foreign',
            extra = (ingestion[organization] ?? []).map(
                (row) => row.binding ?? row
            );
        need(
            bindings[organization].length ===
                (organization === 'A' ? 200 : 24) &&
                extra.length <= 6 &&
                extra.every((row) => id(row.documentId) && id(row.versionId)),
            'LOAD_OBS_TRAFFIC_INVENTORY'
        );
        await inventory(
            api,
            role,
            'documents',
            [...bindings[organization], ...extra].map((row) => row.documentId),
            check
        );
        await inventory(
            api,
            role,
            'collections',
            organization === 'A'
                ? [
                      fullReport.collections.primary.collectionId,
                      fullReport.collections.pilot.collectionId,
                      baseline.collections.ingestionA.collectionId,
                  ]
                : [
                      baseline.collections.referenceB.collectionId,
                      baseline.collections.ingestionB.collectionId,
                  ],
            check
        );
        check();
        const collection = collections[organization],
            saved = (
                await api.call(role, 'collections.get', {
                    id: collection.collectionId,
                })
            ).value;
        check();
        const status = (
            await api.call(role, 'indexing.status', {
                collectionId: collection.collectionId,
            })
        ).value;
        check();
        need(
            saved.configurationRevision === 1 &&
                saved.permissions?.read &&
                saved.permissions.manageDocuments &&
                saved.permissions.administer &&
                Object.entries(collection.profile).every(([key, value]) =>
                    same(saved.configuration?.[key], value)
                ) &&
                status.active?.id === collection.generationId &&
                status.active.status === 'ACTIVE' &&
                status.active.projectedChunks === collection.activeChildren &&
                status.usage.reservedChunks === 0 &&
                status.usage.retainedChunks === 0,
            'LOAD_OBS_PRIMARY_CHANGED'
        );
        check();
        const proof = await observer.observeGeneration({
            collectionId: collection.collectionId,
            organizationId:
                organization === 'A'
                    ? fixture.users.owner.organizationId
                    : fixture.users.foreign.organizationId,
            generationId: collection.generationId,
            bindings: bindings[organization],
            descriptors: descriptors[organization],
            nativeBaseline: collection.nativeBaseline,
            expectedNativeWorkProof: collection.observation.nativeWorkProof,
            expectedChildren: collection.activeChildren,
            expectedParents: collection.parents,
        });
        check();
        need(
            proof.physicalChildren === collection.activeChildren &&
                proof.parents === collection.parents &&
                proof.manifestSha256 ===
                    collection.observation.manifestSha256 &&
                same(
                    proof.usage.nativeWorkProof,
                    collection.observation.nativeWorkProof
                ),
            'LOAD_OBS_PRIMARY_CHANGED'
        );
    }
    return true;
}
