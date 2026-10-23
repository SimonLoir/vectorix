/** Synthetic scorer inputs only. These are not provider responses or acceptance evidence. */
import { sha256, resolvedFilters } from './evaluate.mjs';

export function projectedSources(artifact, startOffset, endOffset) {
    return artifact.sources.flatMap((source) => {
        const start = Math.max(startOffset, source.start);
        const end = Math.min(endOffset, source.end);
        return start < end
            ? [{ source: structuredClone(source), start, end }]
            : [];
    });
}

export function replaceRange(passage, artifact, startOffset, endOffset) {
    passage.startOffset = startOffset;
    passage.endOffset = endOffset;
    passage.text = artifact.text.slice(startOffset, endOffset);
    const spans = projectedSources(artifact, startOffset, endOffset);
    passage.sourceSpans = spans.slice(0, 64);
    passage.sourceSpansTruncated = spans.length > 64;
}

export function syntheticCapture(fixtures) {
    const { manifest, queries, qrels, policy, artifacts } = fixtures;
    const organizationId = 'm7c-synthetic-test-org';
    const documents = manifest.documents.map((doc) => ({
        fixtureId: doc.fixtureId,
        documentId: `test-${doc.fixtureId}`,
        version: 1,
        originalSha256: doc.originalSha256,
        canonicalSha256: doc.canonicalSha256,
    }));
    const binding = new Map(documents.map((doc) => [doc.fixtureId, doc]));
    const profiles = policy.strategies.map((chunkStrategy) => ({
        chunkStrategy,
        organizationId,
        collectionId: `test-${chunkStrategy}-collection`,
        generationId: `test-${chunkStrategy}-generation`,
        chunkerVersion:
            chunkStrategy === 'DOCUMENT_STRUCTURE'
                ? 'structure-utf8-v1'
                : chunkStrategy === 'TOKEN_WINDOW'
                  ? 'token-window-utf8-v1'
                  : 'semantic-utf8-v1',
        parentContextVersion: 'parent-context-utf8-v1',
        model: structuredClone(policy.model),
        profile: structuredClone(policy.profile),
        commit: '1'.repeat(40),
        savedIdentitySha256: '2'.repeat(64),
    }));
    const passages = profiles.flatMap((profile) =>
        manifest.documents.map((doc) => {
            const artifact = artifacts[doc.fixtureId];
            const anchor = doc.goldSpans[0];
            const passage = {
                id: `${profile.chunkStrategy}/${doc.fixtureId}/primary`,
                chunkStrategy: profile.chunkStrategy,
                fixtureId: doc.fixtureId,
                documentId: binding.get(doc.fixtureId).documentId,
                publicationId: `test-${profile.chunkStrategy}-${doc.fixtureId}-publication`,
                organizationId,
                generationId: profile.generationId,
                collectionId: profile.collectionId,
                version: 1,
                language: doc.language,
                mediaType: doc.mediaType,
                metadata: structuredClone(doc.metadata),
                parentContext: {
                    id: `${profile.chunkStrategy}/${doc.fixtureId}/parent`,
                },
            };
            replaceRange(
                passage,
                artifact,
                anchor.startOffset,
                anchor.endOffset
            );
            replaceRange(
                passage.parentContext,
                artifact,
                0,
                artifact.text.length
            );
            return passage;
        })
    );
    const runs = profiles.flatMap((profile) =>
        policy.modes.flatMap((searchStrategy) =>
            [1, 2].flatMap((repeat) =>
                queries.map((query) => {
                    const label = qrels.find(
                        (item) => item.queryId === query.id
                    );
                    return {
                        queryId: query.id,
                        chunkStrategy: profile.chunkStrategy,
                        searchStrategy,
                        repeat,
                        status: 'SUCCESS',
                        organizationId,
                        collectionId: profile.collectionId,
                        generationId: profile.generationId,
                        model: policy.model.model,
                        querySha256: sha256(query.text),
                        filters: resolvedFilters(query, binding),
                        topK: 10,
                        results: [
                            `${profile.chunkStrategy}/${label.editions[0].fixtureId}/primary`,
                        ],
                        parentUnderfilled: true,
                        vectorUnderfilled: false,
                    };
                })
            )
        )
    );
    const sourceProofs = profiles.flatMap((profile) =>
        documents.map((doc) => ({
            ...doc,
            id: `${profile.chunkStrategy}/${doc.fixtureId}`,
            organizationId,
            collectionId: profile.collectionId,
            generationId: profile.generationId,
            publicationId: `test-${profile.chunkStrategy}-${doc.fixtureId}-publication`,
            httpStatus: 200,
        }))
    );
    const accessChecks = profiles.flatMap((profile) =>
        [
            'CURRENT_READER_ALLOWED',
            'REVOKED_GRANT_DENIED',
            'FOREIGN_ORGANIZATION_DENIED',
            'OLD_RECEIPT_AFTER_REVOCATION_DENIED',
        ].map((kind) => ({
            chunkStrategy: profile.chunkStrategy,
            kind,
            httpStatus: kind === 'CURRENT_READER_ALLOWED' ? 200 : 403,
            returnedFixtureIds:
                kind === 'CURRENT_READER_ALLOWED'
                    ? [manifest.documents[0].fixtureId]
                    : [],
        }))
    );
    return {
        schemaVersion: 1,
        namespace: manifest.namespace,
        corpusDigest: manifest.corpusDigest,
        evidenceKind: 'SYNTHETIC_UNIT_TEST',
        organizationId,
        documents,
        profiles,
        sourceProofs,
        passages,
        runs,
        accessChecks,
    };
}
