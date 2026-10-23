/** Offline, bounded scoring of synthetic-corpus evidence. It never performs HTTP or I/O itself. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { matchesFilters } from './queries.mjs';

export const sha256 = (value) =>
    createHash('sha256').update(value).digest('hex');
const REQUIRED_ACCESS = [
    'CURRENT_READER_ALLOWED',
    'REVOKED_GRANT_DENIED',
    'FOREIGN_ORGANIZATION_DENIED',
    'OLD_RECEIPT_AFTER_REVOCATION_DENIED',
];
const VERSIONS = {
    DOCUMENT_STRUCTURE: 'structure-utf8-v1',
    TOKEN_WINDOW: 'token-window-utf8-v1',
    SEMANTIC: 'semantic-utf8-v1',
};
const SAFE_ERROR = /^[A-Z][A-Z0-9_]{0,63}$/u;
const key = (strategy, mode, repeat, queryId) =>
    `${strategy}/${mode}/${repeat}/${queryId}`;
const within = (range, span) =>
    range.startOffset <= span.startOffset && range.endOffset >= span.endOffset;

export function safeOffset(text, offset) {
    return (
        Number.isSafeInteger(offset) &&
        offset >= 0 &&
        offset <= text.length &&
        !(
            offset > 0 &&
            offset < text.length &&
            /[\uD800-\uDBFF]/u.test(text[offset - 1]) &&
            /[\uDC00-\uDFFF]/u.test(text[offset])
        )
    );
}

/** Resolve only the explicit fixture-to-real-ID adapter; never expand an implicit filter. */
export function resolvedFilters(query, bindings) {
    const { documentFixtureIds, ...rest } = query.filters;
    return {
        ...rest,
        ...(documentFixtureIds
            ? {
                  documentIds: documentFixtureIds.map(
                      (id) => bindings.get(id)?.documentId
                  ),
              }
            : {}),
    };
}

function uniqueMap(items, field, maximum) {
    assert(
        Array.isArray(items) && items.length <= maximum,
        'INVALID_BOUNDED_ARRAY'
    );
    const entries = new Map();
    for (const item of items) {
        assert(
            item &&
                typeof item === 'object' &&
                typeof item[field] === 'string' &&
                item[field].length > 0 &&
                item[field].length <= 200,
            'INVALID_ID'
        );
        assert(!entries.has(item[field]), 'DUPLICATE_ID');
        entries.set(item[field], item);
    }
    return entries;
}

export function validateFixtures(fixtures) {
    const { manifest, queries, qrels, policy, artifacts } = fixtures;
    assert.equal(manifest.namespace, 'vectorix-m7c-quality');
    assert.equal(manifest.documents.length, 24);
    assert.equal(queries.length, 40);
    assert.equal(qrels.length, 40);
    assert.equal(policy.offsetUnit, 'UTF16_CODE_UNITS');
    assert.equal(manifest.offsetUnit, 'UTF16_CODE_UNITS');
    assert.equal(manifest.canonicalHashEncoding, 'UTF8');
    const digestInput = {
        documents: manifest.documents,
        queries,
        qrels,
        policy,
    };
    assert.equal(
        sha256(JSON.stringify(digestInput)),
        manifest.corpusDigest,
        'CORPUS_DIGEST_MISMATCH'
    );
    const docs = uniqueMap(manifest.documents, 'fixtureId', 24);
    const byQuery = uniqueMap(queries, 'id', 40);
    const labels = uniqueMap(qrels, 'queryId', 40);
    assert.equal(queries.filter((query) => query.language === 'EN').length, 20);
    assert.equal(queries.filter((query) => query.language === 'FR').length, 20);
    for (const doc of docs.values()) {
        const artifact = artifacts[doc.fixtureId];
        assert(
            artifact &&
                typeof artifact.text === 'string' &&
                artifact.text.length <= 20_000,
            'MISSING_CANONICAL_ARTIFACT'
        );
        assert.equal(sha256(artifact.text), doc.canonicalSha256);
        assert.equal(artifact.text.length, doc.canonicalLength);
        assert.equal(Buffer.byteLength(artifact.text), doc.canonicalUtf8Bytes);
        assert.equal(doc.canonicalStatus, 'CONFIRMED_LOCAL_PARSER');
        let previous = 0;
        for (const [index, source] of artifact.sources.entries()) {
            assert.equal(source.index, index);
            assert(
                safeOffset(artifact.text, source.start) &&
                    safeOffset(artifact.text, source.end) &&
                    source.start >= previous &&
                    source.end >= source.start
            );
            previous = source.end;
        }
        assert.equal(doc.goldSpans.length, 2);
        for (const span of doc.goldSpans) {
            assert(
                safeOffset(artifact.text, span.startOffset) &&
                    safeOffset(artifact.text, span.endOffset) &&
                    span.endOffset > span.startOffset
            );
            assert.equal(
                sha256(artifact.text.slice(span.startOffset, span.endOffset)),
                span.textSha256
            );
        }
    }
    for (const query of queries) {
        const label = labels.get(query.id);
        assert(label && label.editions.length > 0, 'MISSING_QREL');
        assert.equal(label.factDenominator, label.requiredFacts.length);
        assert.equal(label.factDenominator, query.requiresJointParent ? 2 : 1);
        for (const edition of label.editions) {
            const doc = docs.get(edition.fixtureId);
            assert(
                doc &&
                    doc.kind === 'CORE' &&
                    doc.factFamily === query.factFamily &&
                    matchesFilters(doc, query.filters)
            );
            assert.equal(doc.canonicalSha256, edition.canonicalSha256);
            assert.equal(doc.version, edition.version);
            assert(
                isDeepStrictEqual(
                    edition.spans,
                    doc.goldSpans.filter((span) =>
                        label.requiredFacts.includes(span.anchorId)
                    )
                )
            );
        }
        const eligible = manifest.documents
            .filter(
                (doc) =>
                    doc.kind === 'CORE' &&
                    doc.factFamily === query.factFamily &&
                    matchesFilters(doc, query.filters)
            )
            .map((doc) => doc.fixtureId)
            .sort();
        assert(
            isDeepStrictEqual(editionIds(label), eligible),
            'QREL_EDITION_OMISSION'
        );
    }
    return { docs, byQuery, labels };
}

function editionIds(label) {
    return label.editions.map((edition) => edition.fixtureId).sort();
}

function expectedSpans(artifact, passage) {
    return artifact.sources.flatMap((source) => {
        const start = Math.max(source.start, passage.startOffset);
        const end = Math.min(source.end, passage.endOffset);
        return start < end ? [{ source, start, end }] : [];
    });
}

function validatePassageRange(passage, artifact, add, prefix = '') {
    const code = (name) => add(`${prefix}${name}`);
    if (
        !safeOffset(artifact.text, passage.startOffset) ||
        !safeOffset(artifact.text, passage.endOffset) ||
        passage.endOffset <= passage.startOffset ||
        typeof passage.text !== 'string' ||
        passage.text.length > 49_152
    ) {
        code('INVALID_CANONICAL_RANGE');
        return false;
    }
    if (
        passage.text !==
        artifact.text.slice(passage.startOffset, passage.endOffset)
    ) {
        code('CANONICAL_TEXT_MISMATCH');
        return false;
    }
    const spans = expectedSpans(artifact, passage);
    if (
        !isDeepStrictEqual(passage.sourceSpans, spans.slice(0, 64)) ||
        passage.sourceSpansTruncated !== spans.length > 64
    )
        code('SOURCE_PROVENANCE_MISMATCH');
    return true;
}

function validateIdentity(profile, policy) {
    return (
        profile.chunkerVersion === VERSIONS[profile.chunkStrategy] &&
        profile.parentContextVersion === 'parent-context-utf8-v1' &&
        Object.entries(policy.model).every(
            ([field, value]) => profile.model?.[field] === value
        ) &&
        [
            'targetTokens',
            'minTokens',
            'maxTokens',
            'overlapTokens',
            'parentChild',
            'parentMaxTokens',
            'indexType',
            'preparation',
        ].every(
            (field) => profile.profile?.[field] === policy.profile[field]
        ) &&
        isDeepStrictEqual(
            profile.profile?.metadataFields,
            policy.profile.metadataFields
        ) &&
        (profile.chunkStrategy !== 'SEMANTIC' ||
            profile.profile?.semanticPercentile ===
                policy.profile.semanticPercentile) &&
        /^[a-f\d]{40}$/u.test(profile.commit ?? '') &&
        /^[a-f\d]{64}$/u.test(profile.savedIdentitySha256 ?? '')
    );
}

/** Missing evidence never creates PASS; synthetic test captures can exercise gates but are always NOT_RUN live. */
export function evaluateCapture(fixtures, capture) {
    const { manifest, queries, qrels, policy, artifacts } = fixtures;
    const { docs, byQuery, labels } = validateFixtures(fixtures);
    assert(
        capture &&
            capture.schemaVersion === 1 &&
            capture.namespace === manifest.namespace,
        'INVALID_CAPTURE'
    );
    assert(
        ['PREPARED', 'SYNTHETIC_UNIT_TEST', 'LIVE_NATIVE_ISOLATED'].includes(
            capture.evidenceKind
        ),
        'INVALID_EVIDENCE_KIND'
    );
    assert.equal(
        capture.corpusDigest,
        manifest.corpusDigest,
        'CAPTURE_CORPUS_MISMATCH'
    );
    assert(
        Buffer.byteLength(JSON.stringify(capture)) <=
            policy.captureLimits.bytes,
        'CAPTURE_BYTE_LIMIT'
    );
    const bindings = uniqueMap(capture.documents ?? [], 'fixtureId', 24);
    const profiles = uniqueMap(capture.profiles ?? [], 'chunkStrategy', 3);
    const proofs = uniqueMap(capture.sourceProofs ?? [], 'id', 72);
    const passages = uniqueMap(capture.passages ?? [], 'id', 2048);
    const missing = new Set();
    const violationCounts = new Map();
    const add = (code) =>
        violationCounts.set(code, (violationCounts.get(code) ?? 0) + 1);
    if (
        typeof capture.organizationId !== 'string' ||
        !capture.organizationId.length ||
        capture.organizationId.length > 200
    )
        missing.add('ORGANIZATION_BINDING');
    if (
        new Set([...bindings.values()].map((binding) => binding.documentId))
            .size !== bindings.size
    )
        add('DUPLICATE_DOCUMENT_BINDING');
    if (
        new Set([...profiles.values()].map((profile) => profile.generationId))
            .size !== profiles.size ||
        new Set([...profiles.values()].map((profile) => profile.collectionId))
            .size !== profiles.size
    )
        add('INDEPENDENT_PROFILE_BINDING_MISMATCH');
    for (const strategy of policy.strategies) {
        const profile = profiles.get(strategy);
        if (!profile) {
            missing.add(`PROFILE_${strategy}`);
            continue;
        }
        if (
            !validateIdentity(profile, policy) ||
            profile.organizationId !== capture.organizationId ||
            !profile.generationId ||
            !profile.collectionId
        )
            add('NATIVE_OR_PROFILE_IDENTITY_MISMATCH');
    }
    for (const doc of docs.values()) {
        const binding = bindings.get(doc.fixtureId);
        if (!binding) missing.add('DOCUMENT_BINDING');
        else if (
            !binding.documentId ||
            binding.version !== doc.version ||
            binding.originalSha256 !== doc.originalSha256 ||
            binding.canonicalSha256 !== doc.canonicalSha256
        )
            add('DOCUMENT_VERSION_OR_HASH_MISMATCH');
        for (const strategy of policy.strategies) {
            const proof = proofs.get(`${strategy}/${doc.fixtureId}`);
            const profile = profiles.get(strategy);
            if (!proof) missing.add('EXACT_SOURCE_PROOF');
            else if (
                proof.httpStatus !== 200 ||
                proof.version !== doc.version ||
                proof.originalSha256 !== doc.originalSha256 ||
                proof.canonicalSha256 !== doc.canonicalSha256 ||
                proof.documentId !== binding?.documentId ||
                proof.organizationId !== capture.organizationId ||
                proof.collectionId !== profile?.collectionId ||
                proof.generationId !== profile?.generationId ||
                !proof.publicationId
            )
                add('EXACT_SOURCE_HASH_MISMATCH');
        }
    }
    const validated = new Map();
    for (const passage of passages.values()) {
        const codes = [];
        const fail = (code) => {
            codes.push(code);
            add(code);
        };
        const doc = docs.get(passage.fixtureId);
        const profile = profiles.get(passage.chunkStrategy);
        const binding = bindings.get(passage.fixtureId);
        if (!doc || !profile || !binding) {
            fail('UNKNOWN_PASSAGE_BINDING');
            validated.set(passage.id, false);
            continue;
        }
        if (
            passage.organizationId !== capture.organizationId ||
            passage.organizationId !== profile.organizationId ||
            passage.generationId !== profile.generationId ||
            passage.collectionId !== profile.collectionId ||
            passage.documentId !== binding.documentId ||
            passage.version !== doc.version ||
            !passage.publicationId
        )
            fail('CONTENT_SCOPE_OR_VERSION_MISMATCH');
        const proof = proofs.get(
            `${passage.chunkStrategy}/${passage.fixtureId}`
        );
        if (proof && proof.publicationId !== passage.publicationId)
            fail('EXACT_SOURCE_ASSOCIATION_MISMATCH');
        if (
            passage.language !== doc.language ||
            passage.mediaType !== doc.mediaType ||
            !isDeepStrictEqual(passage.metadata, doc.metadata)
        )
            fail('PUBLICATION_METADATA_MISMATCH');
        const artifact = artifacts[doc.fixtureId];
        const childValid = validatePassageRange(passage, artifact, fail);
        if (!passage.parentContext) missing.add('PARENT_CONTEXT_EVIDENCE');
        else {
            const parent = passage.parentContext;
            validatePassageRange(parent, artifact, fail, 'PARENT_');
            if (
                typeof parent.id !== 'string' ||
                parent.id.length < 1 ||
                parent.id.length > 200 ||
                !within(parent, passage)
            )
                fail('PARENT_ASSOCIATION_MISMATCH');
        }
        validated.set(passage.id, childValid && !codes.length);
    }
    assert(
        Array.isArray(capture.runs ?? []) &&
            (capture.runs ?? []).length <= policy.captureLimits.queries,
        'RUN_COUNT_LIMIT'
    );
    const runs = new Map();
    for (const run of capture.runs ?? []) {
        assert(
            byQuery.has(run.queryId) &&
                policy.strategies.includes(run.chunkStrategy) &&
                policy.modes.includes(run.searchStrategy) &&
                [1, 2].includes(run.repeat),
            'UNKNOWN_RUN_CELL'
        );
        const cell = key(
            run.chunkStrategy,
            run.searchStrategy,
            run.repeat,
            run.queryId
        );
        assert(!runs.has(cell), 'DUPLICATE_RUN_CELL');
        assert(
            ['SUCCESS', 'ERROR', 'NOT_RUN'].includes(run.status),
            'INVALID_RUN_STATUS'
        );
        assert(
            Array.isArray(run.results) && run.results.length <= 10,
            'RESULT_COUNT_LIMIT'
        );
        assert(
            run.status === 'SUCCESS' || run.results.length === 0,
            'FAILED_RUN_WITH_RESULTS'
        );
        if (run.status === 'ERROR')
            assert(
                SAFE_ERROR.test(run.errorCode ?? ''),
                'UNSANITIZED_ERROR_CODE'
            );
        if (run.status === 'SUCCESS') {
            const profile = profiles.get(run.chunkStrategy);
            if (
                run.generationId !== profile?.generationId ||
                run.collectionId !== profile?.collectionId ||
                run.organizationId !== capture.organizationId ||
                run.model !== policy.model.model
            )
                add('RESPONSE_SCOPE_OR_MODEL_MISMATCH');
            if (
                typeof run.parentUnderfilled !== 'boolean' ||
                typeof run.vectorUnderfilled !== 'boolean'
            )
                missing.add('UNDERFILL_OBSERVATION');
        }
        if (run.status !== 'NOT_RUN') {
            const query = byQuery.get(run.queryId);
            if (
                run.querySha256 !== sha256(query.text) ||
                !isDeepStrictEqual(
                    run.filters,
                    resolvedFilters(query, bindings)
                ) ||
                run.topK !== 10
            )
                add('REQUEST_DEFINITION_MISMATCH');
        }
        runs.set(cell, run);
    }
    const access = new Map();
    assert(
        Array.isArray(capture.accessChecks ?? []) &&
            (capture.accessChecks ?? []).length <= 12,
        'ACCESS_COUNT_LIMIT'
    );
    for (const check of capture.accessChecks ?? []) {
        assert(
            policy.strategies.includes(check.chunkStrategy) &&
                REQUIRED_ACCESS.includes(check.kind),
            'UNKNOWN_ACCESS_CASE'
        );
        const accessKey = `${check.chunkStrategy}/${check.kind}`;
        assert(!access.has(accessKey), 'DUPLICATE_ACCESS_CASE');
        access.set(accessKey, check);
        if (check.kind === 'CURRENT_READER_ALLOWED') {
            if (
                check.httpStatus !== 200 ||
                !Array.isArray(check.returnedFixtureIds) ||
                !check.returnedFixtureIds.length ||
                check.returnedFixtureIds.some((id) => !docs.has(id))
            )
                add('CURRENT_READER_ACCESS_MISMATCH');
        } else if (
            ![403, 404].includes(check.httpStatus) ||
            !Array.isArray(check.returnedFixtureIds) ||
            check.returnedFixtureIds.length !== 0
        )
            add('DENIED_ACCESS_LEAK');
    }
    for (const strategy of policy.strategies)
        for (const kind of REQUIRED_ACCESS)
            if (!access.has(`${strategy}/${kind}`))
                missing.add('ACCESS_CHECKS');

    const cells = [];
    const scores = [];
    for (const strategy of policy.strategies)
        for (const mode of policy.modes)
            for (let repeat = 1; repeat <= 2; repeat++) {
                const details = queries.map((query) => {
                    const run = runs.get(key(strategy, mode, repeat, query.id));
                    const label = labels.get(query.id);
                    const facts = new Set();
                    let firstRelevant = null;
                    let parentHit5 = false;
                    const seen = new Set();
                    const seenParents = new Set();
                    if (!run || run.status === 'NOT_RUN')
                        missing.add('QUERY_CELLS');
                    for (const [index, id] of (run?.results ?? []).entries()) {
                        assert(
                            typeof id === 'string' && id.length <= 200,
                            'INVALID_RESULT_REFERENCE'
                        );
                        if (seen.has(id)) {
                            add('DUPLICATE_RESULT');
                            continue;
                        }
                        seen.add(id);
                        const passage = passages.get(id);
                        if (!passage || !validated.get(id)) {
                            if (!passage) add('MISSING_RESULT_PASSAGE');
                            continue;
                        }
                        if (passage.chunkStrategy !== strategy) {
                            add('RESULT_GENERATION_MISMATCH');
                            continue;
                        }
                        if (
                            passage.parentContext?.id &&
                            seenParents.has(passage.parentContext.id)
                        ) {
                            add('PARENT_DEDUPLICATION_FAILURE');
                            continue;
                        }
                        if (passage.parentContext?.id)
                            seenParents.add(passage.parentContext.id);
                        const doc = docs.get(passage.fixtureId);
                        if (!matchesFilters(doc, query.filters)) {
                            add('FILTER_VIOLATION');
                            continue;
                        }
                        const edition = label.editions.find(
                            (item) => item.fixtureId === passage.fixtureId
                        );
                        if (!edition) continue;
                        const childFacts = edition.spans.filter((span) =>
                            within(passage, span)
                        );
                        const relevant = query.requiresJointParent
                            ? childFacts.length > 0 &&
                              edition.spans.every(
                                  (span) =>
                                      passage.parentContext &&
                                      within(passage.parentContext, span)
                              )
                            : childFacts.some(
                                  (span) => span.anchorId === 'primary'
                              );
                        if (relevant && firstRelevant === null)
                            firstRelevant = index + 1;
                        if (relevant && index < 5 && query.requiresJointParent)
                            parentHit5 = true;
                        if (index < 10 && childFacts.length) {
                            const credited =
                                query.requiresJointParent &&
                                passage.parentContext
                                    ? edition.spans.filter((span) =>
                                          within(passage.parentContext, span)
                                      )
                                    : childFacts;
                            for (const span of credited)
                                facts.add(span.anchorId);
                        }
                    }
                    const item = {
                        queryId: query.id,
                        language: query.language,
                        category: query.category,
                        crossLanguage: query.crossLanguage,
                        status: run?.status ?? 'NOT_RUN',
                        firstRelevantRank: firstRelevant,
                        hit5: firstRelevant !== null && firstRelevant <= 5,
                        reciprocalRank10:
                            firstRelevant !== null && firstRelevant <= 10
                                ? 1 / firstRelevant
                                : 0,
                        factRecall10: facts.size / label.factDenominator,
                        factDenominator: label.factDenominator,
                        parentHit5,
                        parentUnderfilled: run?.parentUnderfilled ?? null,
                        vectorUnderfilled: run?.vectorUnderfilled ?? null,
                    };
                    scores.push({
                        chunkStrategy: strategy,
                        searchStrategy: mode,
                        repeat,
                        ...item,
                    });
                    return item;
                });
                cells.push({
                    chunkStrategy: strategy,
                    searchStrategy: mode,
                    repeat,
                    queryDenominator: 40,
                    completed: details.filter(
                        (item) => item.status === 'SUCCESS'
                    ).length,
                    errors: details.filter((item) => item.status === 'ERROR')
                        .length,
                    notRun: details.filter((item) => item.status === 'NOT_RUN')
                        .length,
                    hit5: details.filter((item) => item.hit5).length,
                    mrr10:
                        details.reduce(
                            (total, item) => total + item.reciprocalRank10,
                            0
                        ) / 40,
                    factRecall10:
                        details.reduce(
                            (total, item) => total + item.factRecall10,
                            0
                        ) / 40,
                    parentUnderfilled: details.filter(
                        (item) => item.parentUnderfilled === true
                    ).length,
                    vectorUnderfilled: details.filter(
                        (item) => item.vectorUnderfilled === true
                    ).length,
                });
            }
    const gateResults = [];
    for (const strategy of policy.strategies)
        for (let repeat = 1; repeat <= 2; repeat++) {
            const select = (mode, predicate = () => true) =>
                scores.filter(
                    (item) =>
                        item.chunkStrategy === strategy &&
                        item.repeat === repeat &&
                        item.searchStrategy === mode &&
                        predicate(item)
                );
            const hit = (items) => items.filter((item) => item.hit5).length;
            const hybrid = select('HYBRID');
            const result = {
                chunkStrategy: strategy,
                repeat,
                exactLexicalHit5: hit(
                    select('LEXICAL', (item) => item.category === 'EXACT')
                ),
                hybridHit5: hit(hybrid),
                hybridEnglishHit5: hit(
                    hybrid.filter((item) => item.language === 'EN')
                ),
                hybridFrenchHit5: hit(
                    hybrid.filter((item) => item.language === 'FR')
                ),
                hybridMrr10:
                    hybrid.reduce(
                        (sum, item) => sum + item.reciprocalRank10,
                        0
                    ) / 40,
                crossLanguageHybridHit5: hit(
                    hybrid.filter((item) => item.crossLanguage)
                ),
                filterHybridHit5: hit(
                    hybrid.filter((item) => item.category === 'FILTER')
                ),
                parentHybridHit5: hybrid.filter(
                    (item) => item.category === 'PARENT' && item.parentHit5
                ).length,
            };
            result.pass =
                result.exactLexicalHit5 >= policy.gates.exactLexicalHit5 &&
                result.hybridHit5 >= policy.gates.hybridHit5 &&
                result.hybridEnglishHit5 >=
                    policy.gates.hybridEachLanguageHit5 &&
                result.hybridFrenchHit5 >=
                    policy.gates.hybridEachLanguageHit5 &&
                result.hybridMrr10 >= policy.gates.hybridMrr10 &&
                result.crossLanguageHybridHit5 >=
                    policy.gates.crossLanguageHybridHit5 &&
                result.filterHybridHit5 >= policy.gates.filterHybridHit5 &&
                result.parentHybridHit5 >= policy.gates.parentHybridHit5;
            gateResults.push(result);
        }
    const hardViolations = [...violationCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({ code, count }));
    const hardSafetyStatus = hardViolations.length
        ? 'FAIL'
        : missing.size
          ? 'INCONCLUSIVE'
          : 'PASS';
    const qualityGatesStatus = hardViolations.length
        ? 'FAIL'
        : missing.size
          ? 'INCONCLUSIVE'
          : gateResults.every((gate) => gate.pass) &&
              !cells.some((cell) => cell.errors)
            ? 'PASS'
            : 'FAIL';
    return {
        schemaVersion: 1,
        corpusDigest: manifest.corpusDigest,
        evidenceKind: capture.evidenceKind,
        status:
            capture.evidenceKind === 'LIVE_NATIVE_ISOLATED'
                ? qualityGatesStatus
                : 'NOT_RUN',
        qualityGatesStatus,
        hardSafetyStatus,
        observedQueryCells: runs.size,
        expectedQueryCells: 720,
        missingEvidence: [...missing].sort(),
        hardViolations,
        gates: gateResults,
        cells,
        queryScores: scores,
        capacityAcceptance: 'NOT_RUN',
        hostedProviderAcceptance: 'NOT_RUN',
        notes: [
            'Offline evidence validation; capture authenticity and actual source downloads require the separately reviewed live collector.',
            'All canonical offsets are UTF16_CODE_UNITS; canonical and original hashes are SHA-256 over UTF8 text and original bytes respectively.',
            'No result count or synthetic perfect score establishes native relevance, ANN recall or 100,000-child capacity.',
        ],
    };
}
