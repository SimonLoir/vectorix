/** Follow only a bounded selection of already returned exact source receipts; never issues a search. */
import { need, same, sha } from './load-observer-core.mjs';
export const STATIC_DRAFT_ONLY = true;
export async function followTrafficSources({ sources, oracle, api, check }) {
    need(
        Array.isArray(sources) && sources.length <= 12,
        'LOAD_OBS_SOURCE_BOUND'
    );
    const proof = [];
    for (const source of sources) {
        check();
        const doc = oracle.sourceDocument(source),
            role = source.organization === 'A' ? 'owner' : 'foreign';
        need(
            doc && source.version === 1 && source.source,
            'LOAD_OBS_SOURCE_PROOF'
        );
        const preview = (
            await api.call(role, 'indexing.sourcePreview', {
                collectionId: source.collectionId,
                receipt: source.receipt,
                sourceIndex: source.source.index,
                offset: 0,
            })
        ).value;
        check();
        const span = doc.artifact.sources[source.source.index],
            expected = doc.artifact.text.slice(span.start, span.end);
        let end = Math.min(20000, expected.length);
        if (end < expected.length && /[\uD800-\uDBFF]/u.test(expected[end - 1]))
            end--;
        need(
            preview.version === 1 &&
                same(preview.source, span) &&
                preview.documentName === doc.fileName &&
                preview.totalCharacters === expected.length &&
                preview.text === expected.slice(0, end) &&
                preview.nextOffset === (expected.length > end ? end : null),
            'LOAD_OBS_SOURCE_PROOF'
        );
        check();
        const original = (
            await api.call(role, 'indexing.sourceOriginal', {
                collectionId: source.collectionId,
                receipt: source.receipt,
            })
        ).value;
        check();
        need(
            original instanceof File &&
                original.size === doc.originalBytes &&
                sha(new Uint8Array(await original.arrayBuffer())) ===
                    doc.originalSha256,
            'LOAD_OBS_SOURCE_PROOF'
        );
        check();
        proof.push({
            organization: source.organization,
            documentId: source.documentId,
            version: 1,
            sourceIndex: span.index,
            originalSha256: doc.originalSha256,
            verified: true,
        });
    }
    return proof;
}
