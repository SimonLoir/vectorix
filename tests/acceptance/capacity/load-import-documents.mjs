/** Normal document I/O only, through injected supported API calls. Content never enters a checkpoint. */
import {
    need,
    sha,
    id,
    same,
    LOAD_LIMITS,
    requestId,
    readList,
} from './load-import-core.mjs';
export async function observeDocument(ctx, role, binding, descriptor) {
    const details = await ctx.call(role, 'documents.details', {
        id: binding.documentId,
    });
    need(
        details.document?.id === binding.documentId &&
            details.document.name === descriptor.fileName &&
            details.document.status === 'READY' &&
            details.canManage === true &&
            details.version?.id === binding.versionId &&
            details.version.version === 1 &&
            details.version.status === 'READY' &&
            details.version.byteSize === descriptor.originalBytes &&
            details.version.mediaType === descriptor.mediaType &&
            details.version.stored === true,
        'LOAD_DOCUMENT_CHANGED'
    );
    let offset = 0,
        text = '',
        pages = 0;
    while (true) {
        need(++pages <= 64, 'LOAD_PREVIEW_PAGE_CAP');
        const page = await ctx.call(role, 'documents.preview', {
            id: binding.documentId,
            offset,
        });
        need(
            page.version === 1 &&
                page.totalCharacters === descriptor.canonicalLength &&
                typeof page.text === 'string' &&
                page.text.length <= 20000 &&
                text.length + page.text.length <= descriptor.canonicalLength,
            'LOAD_CANONICAL_PAGE'
        );
        text += page.text;
        if (page.nextOffset === null) break;
        need(
            page.text.length > 0 &&
                page.nextOffset === offset + page.text.length,
            'LOAD_CANONICAL_PAGE'
        );
        offset = page.nextOffset;
    }
    need(
        text.length === descriptor.canonicalLength &&
            sha(text) === descriptor.canonicalSha256,
        'LOAD_CANONICAL_HASH'
    );
    const original = await ctx.call(role, 'documents.download', {
        id: binding.documentId,
    });
    need(
        original instanceof File &&
            original.size === descriptor.originalBytes &&
            original.size <= LOAD_LIMITS.sourceBytes,
        'LOAD_ORIGINAL_BOUND'
    );
    need(
        sha(new Uint8Array(await original.arrayBuffer())) ===
            descriptor.originalSha256,
        'LOAD_ORIGINAL_HASH'
    );
    return {
        ...binding,
        originalSha256: descriptor.originalSha256,
        canonicalSha256: descriptor.canonicalSha256,
        canonicalLength: descriptor.canonicalLength,
        originalBytes: descriptor.originalBytes,
    };
}
/** Upload each exact original once; the caller must inspect any incomplete mutation before another run. */
export async function importDocuments(
    ctx,
    role,
    descriptors,
    readOriginal,
    { existing = [], deadline } = {}
) {
    need(
        Array.isArray(descriptors) &&
            descriptors.length <= 200 &&
            typeof readOriginal === 'function' &&
            Number.isSafeInteger(deadline),
        'LOAD_DOCUMENT_INPUT'
    );
    const expectedExisting = new Set(
            existing.map((binding) => binding.documentId)
        ),
        before = await readList(ctx, role, 'documents');
    need(
        before.length === expectedExisting.size &&
            before.every((row) => expectedExisting.has(row.id)),
        'LOAD_UNEXPECTED_LIBRARY'
    );
    const bindings = [];
    for (const descriptor of descriptors) {
        need(
            ctx.time() <= deadline &&
                id(descriptor.fixtureId) &&
                descriptor.originalBytes > 0 &&
                descriptor.originalBytes <= LOAD_LIMITS.sourceBytes,
            'LOAD_PHASE_DEADLINE'
        );
        const bytes = await readOriginal(descriptor);
        need(
            bytes instanceof Uint8Array &&
                bytes.byteLength === descriptor.originalBytes &&
                sha(bytes) === descriptor.originalSha256,
            'LOAD_LOCAL_SOURCE_HASH'
        );
        need(ctx.time() <= deadline, 'LOAD_PHASE_DEADLINE');
        const file = new File([bytes], descriptor.fileName, {
            type: descriptor.mediaType,
        });
        const accepted = await ctx.mutate(
            role,
            'documents.upload',
            { requestId: requestId(), file },
            (value) => {
                need(
                    id(value.id) &&
                        id(value.versionId) &&
                        !expectedExisting.has(value.id) &&
                        !bindings.some((row) => row.documentId === value.id),
                    'LOAD_UPLOAD_BINDING'
                );
                return { documentId: value.id, versionId: value.versionId };
            }
        );
        bindings.push({
            fixtureId: descriptor.fixtureId,
            documentId: accepted.id,
            versionId: accepted.versionId,
            version: 1,
        });
    }
    const allowed = new Set([
        ...expectedExisting,
        ...bindings.map((row) => row.documentId),
    ]);
    await ctx.wait(
        () => readList(ctx, role, 'documents'),
        (rows) => {
            need(
                rows.length === allowed.size &&
                    rows.every((row) => allowed.has(row.id)),
                'LOAD_UNEXPECTED_LIBRARY'
            );
            need(
                rows.every(
                    (row) => !['FAILED', 'DELETED'].includes(row.status)
                ),
                'LOAD_EXTRACTION_FAILED'
            );
            return rows.every((row) => row.status === 'READY');
        },
        deadline
    );
    const verified = [];
    for (let index = 0; index < bindings.length; index++) {
        need(ctx.time() <= deadline, 'LOAD_PHASE_DEADLINE');
        verified.push(
            await observeDocument(
                ctx,
                role,
                bindings[index],
                descriptors[index]
            )
        );
    }
    return verified;
}
export async function verifyExistingDocuments(
    ctx,
    role,
    bindings,
    descriptors
) {
    need(bindings.length === descriptors.length, 'LOAD_EXISTING_BINDING');
    for (let index = 0; index < bindings.length; index++) {
        need(
            bindings[index].fixtureId === descriptors[index].fixtureId,
            'LOAD_EXISTING_BINDING'
        );
        await observeDocument(ctx, role, bindings[index], descriptors[index]);
    }
    return bindings;
}
export async function attachDocuments(
    ctx,
    role,
    collection,
    bindings,
    descriptors,
    deadline = ctx.started + LOAD_LIMITS.overallMs
) {
    need(
        bindings.length === descriptors.length && bindings.length <= 200,
        'LOAD_ASSOCIATION_INPUT'
    );
    for (let index = 0; index < bindings.length; index++) {
        need(ctx.time() < deadline, 'LOAD_PHASE_DEADLINE');
        const binding = bindings[index],
            descriptor = descriptors[index];
        need(
            binding.fixtureId === descriptor.fixtureId,
            'LOAD_ASSOCIATION_INPUT'
        );
        await ctx.mutate(
            role,
            'documents.setCollection',
            {
                id: binding.documentId,
                collectionId: collection.collectionId,
                attached: true,
            },
            (value) => {
                need(value.success === true, 'LOAD_ASSOCIATION_RESPONSE');
                return {};
            }
        );
        await ctx.mutate(
            role,
            'indexing.updateMetadata',
            {
                collectionId: collection.collectionId,
                documentId: binding.documentId,
                expectedMetadataRevision: 1,
                language: descriptor.language,
                tags: structuredClone(descriptor.tags),
                metadata: structuredClone(descriptor.metadata),
            },
            (value) => {
                need(value.success === true, 'LOAD_METADATA_RESPONSE');
                return {};
            }
        );
    }
    const rows = [];
    for (let offset = 0; offset < bindings.length; offset += 100) {
        const page = await ctx.call(role, 'indexing.documents', {
            collectionId: collection.collectionId,
            offset,
            limit: 100,
            query: '',
        });
        need(
            page.total === bindings.length &&
                Array.isArray(page.items) &&
                page.items.length <= 100,
            'LOAD_ASSOCIATION_COUNT'
        );
        rows.push(...page.items);
    }
    need(
        rows.length === bindings.length &&
            new Set(rows.map((row) => row.documentId)).size === bindings.length,
        'LOAD_ASSOCIATION_COUNT'
    );
    bindings.forEach((binding, index) => {
        const row = rows.find((row) => row.documentId === binding.documentId),
            descriptor = descriptors[index];
        need(
            row?.libraryVersion === 1 &&
                row.language === descriptor.language &&
                same(row.tags, descriptor.tags) &&
                same(row.metadata, descriptor.metadata),
            'LOAD_METADATA_CHANGED'
        );
    });
}
