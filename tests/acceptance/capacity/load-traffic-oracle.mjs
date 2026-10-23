import { observationPolicy } from './load-observer-core.mjs';
/** Preloaded canonical result oracle. No file, SDK, HTTP or process operation on import. */
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { need, sha, digest, id } from './load-observer-core.mjs';
import {
    loadDescriptor,
    validateManifest,
    validateReferences,
} from './load-import-core.mjs';
import { profileForCollectionRole } from './load-policy-registry.mjs';
import {
    observationBinding,
    assertObservationBinding,
} from './load-observer-policy.mjs';
export const STATIC_DRAFT_ONLY = true;
const compare = (a, b, type) =>
    type === 'DATE'
        ? Date.parse(a) - Date.parse(b)
        : typeof a === 'number' && typeof b === 'number'
          ? a - b
          : typeof a === 'string' && typeof b === 'string'
            ? a.localeCompare(b)
            : NaN;
/** Only declared typed filters are accepted. This is a fixture eligibility check, not a replacement server permission guard. */
export function eligible(document, filters, types) {
    need(
        filters &&
            typeof filters === 'object' &&
            !Array.isArray(filters) &&
            Object.keys(filters).every((key) =>
                [
                    'documentIds',
                    'languages',
                    'mediaTypes',
                    'tags',
                    'createdAfter',
                    'createdBefore',
                    'metadata',
                ].includes(key)
            ),
        'LOAD_OBS_FILTER'
    );
    if (
        filters.documentIds &&
        !filters.documentIds.includes(document.documentId)
    )
        return false;
    if (filters.languages && !filters.languages.includes(document.language))
        return false;
    if (filters.mediaTypes && !filters.mediaTypes.includes(document.mediaType))
        return false;
    if (
        filters.tags &&
        !filters.tags.every((tag) => document.tags.includes(tag))
    )
        return false;
    for (const key of ['createdAfter', 'createdBefore'])
        if (filters[key]) {
            const difference =
                Date.parse(document.createdAt) -
                new Date(filters[key]).getTime();
            need(Number.isFinite(difference), 'LOAD_OBS_FILTER');
            if (key === 'createdAfter' ? difference < 0 : difference > 0)
                return false;
        }
    for (const clause of filters.metadata ?? []) {
        need(
            ['STRING', 'NUMBER', 'BOOLEAN', 'DATE'].includes(
                types[clause.field]
            ),
            'LOAD_OBS_FILTER'
        );
        const actual = document.metadata[clause.field],
            type = types[clause.field];
        const equal = (value) =>
            type === 'DATE'
                ? Number.isFinite(Date.parse(actual)) &&
                  Date.parse(actual) === Date.parse(value)
                : actual === value;
        if (clause.operator === 'EQ' && !equal(clause.value)) return false;
        else if (clause.operator === 'IN' && !clause.value.some(equal))
            return false;
        else if (['GTE', 'LTE'].includes(clause.operator)) {
            const result = compare(actual, clause.value, type);
            if (
                !Number.isFinite(result) ||
                (clause.operator === 'GTE' ? result < 0 : result > 0)
            )
                return false;
        } else need(['EQ', 'IN'].includes(clause.operator), 'LOAD_OBS_FILTER');
    }
    return true;
}
/** Build before timing: retain canonical documents/ranges/hashes, never generate source text during an HTTP interval. */
export async function prepareTrafficOracle({
    state,
    fixture,
    fullReport,
    references,
    manifest,
    catalogs,
    readCanonical,
    plan,
    prepareInput,
}) {
    const policy = observationPolicy(state);
    validateManifest(manifest, policy);
    validateReferences(references, policy);
    need(
        fullReport?.status === 'COMPLETE' &&
            fullReport.workflow === 'full' &&
            fullReport.collections.primary.activeChildren === 100000 &&
            fullReport.collections.primary.parents === 25000 &&
            fullReport.experimentPolicyId === policy.id &&
            fullReport.policySha256 === state.experimentPolicySha256 &&
            fullReport.familySha256 === policy.identity.family &&
            fullReport.corpusSha256 === policy.identity.full,
        'LOAD_OBS_FULL_REPORT'
    );
    need(
        references.queries?.length === 40 &&
            manifest.documents.length === 200 &&
            typeof plan === 'function' &&
            typeof prepareInput === 'function',
        'LOAD_OBS_ORACLE_INPUT'
    );
    const reports = {
            A: fullReport.collections.primary,
            B: fullReport.baseline.collections.referenceB,
        },
        bindings = {
            A: fullReport.documents.loadA,
            B: fullReport.baseline.documents.referenceB,
        },
        descriptors = {
            A: manifest.documents.map((doc) => loadDescriptor(doc, policy)),
            B: references.manifest.documents,
        },
        types = {
            A: {
                topic: 'STRING',
                document_no: 'NUMBER',
                active: 'BOOLEAN',
                dataset: 'STRING',
            },
            B: references.manifest.metadataFields,
        },
        maps = { A: new Map(), B: new Map() };
    const totals = {
        A: { children: 0, parents: 0 },
        B: { children: 0, parents: 0 },
    };
    for (const organization of ['A', 'B']) {
        const catalog = catalogs[organization],
            report = reports[organization],
            collectionRole = organization === 'A' ? 'primaryA' : 'referenceB',
            expectedBinding = observationBinding(state, fixture, {
                collectionRole,
                policySha256: state.experimentPolicySha256,
                organizationId: catalog.organizationId,
            }),
            profile = profileForCollectionRole(
                policy,
                collectionRole,
                types[organization]
            );
        assertObservationBinding(report, expectedBinding);
        assertObservationBinding(catalog, expectedBinding);
        need(
            isDeepStrictEqual(report.profile, profile),
            'LOAD_OBS_POLICY_BINDING'
        );
        need(
            catalog.generationId === report.generationId &&
                catalog.collectionId === report.collectionId &&
                catalog.documents.length === bindings[organization].length &&
                catalog.modelIdentity.provider === 'OLLAMA' &&
                catalog.modelIdentity.digest === policy.identity.weights &&
                catalog.modelIdentity.dimensions === 768,
            'LOAD_OBS_ORACLE_CATALOG'
        );
        for (const [index, binding] of bindings[organization].entries()) {
            const descriptor = descriptors[organization][index],
                saved = catalog.documents.find(
                    (row) => row.documentId === binding.documentId
                );
            need(
                saved &&
                    saved.versionId === binding.versionId &&
                    id(saved.publicationId) &&
                    isDeepStrictEqual(saved.metadata, descriptor.metadata) &&
                    isDeepStrictEqual(saved.tags, descriptor.tags) &&
                    saved.language === descriptor.language,
                'LOAD_OBS_ORACLE_CATALOG'
            );
            const artifact = await readCanonical(descriptor);
            need(
                sha(artifact.text) === descriptor.canonicalSha256,
                'LOAD_OBS_CANONICAL_HASH'
            );
            const layout = plan(
                    artifact,
                    catalog.modelIdentity,
                    descriptor.fileName,
                    profile
                ),
                planned = [...layout.children, ...layout.parents];
            totals[organization].children += layout.children.length;
            totals[organization].parents += layout.parents.length;
            need(
                saved.chunks.length === planned.length &&
                    planned.length <= 1000,
                'LOAD_OBS_LAYOUT_BOUND'
            );
            const chunks = new Map(),
                geometry = createHash('sha256');
            planned.forEach((row, ordinal) => {
                const actual = saved.chunks.find(
                        (chunk) => chunk.ordinal === ordinal
                    ),
                    child = ordinal < layout.children.length,
                    inputHash = child
                        ? sha(
                              prepareInput(
                                  catalog.modelIdentity,
                                  'document',
                                  row.text,
                                  {
                                      title: descriptor.fileName,
                                      preparation: '',
                                  }
                              )
                          )
                        : null;
                need(
                    actual &&
                        id(actual.id) &&
                        actual.kind === (child ? 'CHILD' : 'PARENT') &&
                        actual.startOffset === row.start &&
                        actual.endOffset === row.end &&
                        actual.textHash === sha(row.text) &&
                        actual.embeddingInputHash === inputHash &&
                        actual.parentId ===
                            (child
                                ? saved.chunks.find(
                                      (parent) =>
                                          parent.ordinal ===
                                          layout.mapping[ordinal]
                                  )?.id
                                : null),
                    'LOAD_OBS_ORACLE_CHUNK'
                );
                chunks.set(actual.id, {
                    ...actual,
                    sourceSpans: row.sourceSpans,
                    tokenCount: row.tokenCount,
                });
                if (child)
                    geometry.update(
                        JSON.stringify([
                            ordinal,
                            row.start,
                            row.end,
                            sha(row.text),
                            inputHash,
                            row.sourceSpans.map((span) => [
                                span.source.index,
                                span.start,
                                span.end,
                            ]),
                        ]) + '\n'
                    );
            });
            const geometryHash = geometry.digest('hex');
            if (descriptor.expectedGeometrySha256)
                need(
                    geometryHash === descriptor.expectedGeometrySha256,
                    'LOAD_OBS_FROZEN_GEOMETRY'
                );
            maps[organization].set(binding.documentId, {
                ...saved,
                chunks,
                childCount: layout.children.length,
                artifact,
                mediaType: descriptor.mediaType,
                fileName: descriptor.fileName,
                fixtureId: descriptor.fixtureId,
                originalSha256: descriptor.originalSha256,
                originalBytes: descriptor.originalBytes,
            });
        }
    }
    need(
        totals.A.children === 100000 &&
            totals.A.parents === 25000 &&
            totals.B.children > 0,
        'LOAD_OBS_ORACLE_CATALOG'
    );
    const controls = createLexicalControls(references, maps.B);
    const request = (offer) =>
        trafficRequest(offer, { maps, reports, types, references });
    /* Fixed mapping was selected before any native load result. */
    const validate = (offer, value) =>
        validateTrafficResult(offer, value, {
            request,
            maps,
            reports,
            types,
            controls,
        });
    // Freeze every planned mapping before time zero; query bytes never enter evidence.
    const scheduleSha256 = digest(
        ['A', 'B'].flatMap((organization) =>
            Array.from({ length: 40 }, (_, queryOrdinal) =>
                [false, true].map((selectiveFilter) => {
                    const offer = {
                        organization,
                        queryOrdinal,
                        language: queryOrdinal % 2 ? 'FR' : 'EN',
                        selectiveFilter,
                        mode: 'HYBRID',
                    };
                    return {
                        organization,
                        queryOrdinal,
                        selectiveFilter,
                        requestSha256: digest(request(offer)),
                    };
                })
            ).flat()
        )
    );
    return {
        request,
        validate,
        scheduleSha256,
        sourceDocument: (source) =>
            maps[source.organization].get(source.documentId),
        generationIds: { A: reports.A.generationId, B: reports.B.generationId },
        collections: reports,
    };
}
/** The primary unfiltered variant admits all100k children; selective variants retain explicit typed filters. */
export function trafficRequest(offer, { maps, reports, types, references }) {
    need(
        ['A', 'B'].includes(offer.organization) &&
            Number.isSafeInteger(offer.queryOrdinal) &&
            offer.queryOrdinal >= 0 &&
            offer.queryOrdinal < 40,
        'LOAD_OBS_QUERY'
    );
    let query, filters;
    if (offer.organization === 'A') {
        query =
            offer.language === 'FR'
                ? 'retour reçu contrôle'
                : 'returns receipt inspection';
        filters = offer.selectiveFilter
            ? {
                  languages: [offer.language],
                  metadata: [{ field: 'active', operator: 'EQ', value: true }],
              }
            : {};
    } else {
        const q = references.queries[offer.queryOrdinal];
        need(q.language === offer.language, 'LOAD_OBS_QUERY');
        query = q.text;
        filters = structuredClone(q.filters);
        if (filters.documentFixtureIds) {
            filters.documentIds = filters.documentFixtureIds.map((key) => {
                const found = [...maps.B.values()].find(
                    (row) => row.fixtureId === key
                );
                need(found, 'LOAD_OBS_FILTER');
                return found.documentId;
            });
            delete filters.documentFixtureIds;
        }
    }
    const documents = [...maps[offer.organization].values()].filter((row) =>
        eligible(row, filters, types[offer.organization])
    );
    need(documents.length > 0, 'LOAD_OBS_EMPTY_ELIGIBILITY');
    if (offer.selectiveFilter)
        filters.documentIds = [
            documents[offer.queryOrdinal % documents.length].documentId,
        ];
    return {
        collectionId: reports[offer.organization].collectionId,
        query,
        topK: 10,
        strategy: offer.mode,
        filters,
    };
}
/** Validate canonical rows from an already independently observed metadata map, without a timed source read. */
export function validateTrafficResult(
    offer,
    value,
    { request, maps, reports, types, controls }
) {
    const input = request(offer),
        map = maps[offer.organization],
        report = reports[offer.organization];
    need(
        value.generationId === report.generationId &&
            value.model === 'embeddinggemma:latest' &&
            value.strategy === offer.mode &&
            Array.isArray(value.results) &&
            value.results.length <= 10 &&
            typeof value.vectorUnderfilled === 'boolean' &&
            (value.parentUnderfilled === undefined ||
                typeof value.parentUnderfilled === 'boolean'),
        'LOAD_OBS_SEARCH_IDENTITY'
    );
    const parents = new Set();
    for (const row of value.results) {
        const doc = map.get(row.documentId),
            chunk = doc?.chunks.get(row.id);
        need(
            doc &&
                chunk?.kind === 'CHILD' &&
                row.generationId === report.generationId &&
                row.publicationId === doc.publicationId &&
                row.version === 1 &&
                row.ordinal === chunk.ordinal &&
                row.published === true &&
                row.documentName === doc.fileName &&
                row.mediaType === doc.mediaType &&
                row.language === doc.language &&
                isDeepStrictEqual(row.tags, doc.tags) &&
                isDeepStrictEqual(row.metadata, doc.metadata) &&
                eligible(doc, input.filters, types[offer.organization]),
            'LOAD_OBS_SEARCH_SCOPE'
        );
        need(
            row.startOffset === chunk.startOffset &&
                row.endOffset === chunk.endOffset &&
                row.text ===
                    doc.artifact.text.slice(
                        chunk.startOffset,
                        chunk.endOffset
                    ) &&
                sha(row.text) === chunk.textHash &&
                isDeepStrictEqual(
                    row.sourceSpans,
                    chunk.sourceSpans.slice(0, 64)
                ) &&
                row.sourceSpansTruncated === chunk.sourceSpans.length > 64 &&
                row.tokenCount === chunk.tokenCount &&
                row.tokenCountIsEstimate === true,
            'LOAD_OBS_SEARCH_CANONICAL'
        );
        const parent = doc.chunks.get(chunk.parentId),
            context = row.parentContext;
        need(
            parent &&
                context?.id === parent.id &&
                !parents.has(parent.id) &&
                context.ordinal === parent.ordinal &&
                context.startOffset === parent.startOffset &&
                context.endOffset === parent.endOffset &&
                context.text ===
                    doc.artifact.text.slice(
                        parent.startOffset,
                        parent.endOffset
                    ) &&
                sha(context.text) === parent.textHash &&
                context.tokenCount === parent.tokenCount &&
                context.tokenCountIsEstimate === true &&
                isDeepStrictEqual(
                    context.sourceSpans,
                    parent.sourceSpans.slice(0, 64)
                ) &&
                context.sourceSpansTruncated === parent.sourceSpans.length > 64,
            'LOAD_OBS_SEARCH_PARENT'
        );
        parents.add(parent.id);
        const score = row.scores,
            rank = (value) =>
                value === null || (Number.isSafeInteger(value) && value > 0);
        need(
            score &&
                Number.isFinite(score.rrf) &&
                score.rrf >= 0 &&
                rank(score.lexicalRank) &&
                rank(score.vectorRank) &&
                (score.vectorDistance === null ||
                    Number.isFinite(score.vectorDistance)) &&
                (score.vectorRank === null
                    ? score.vectorDistance === null
                    : score.vectorDistance !== null) &&
                (offer.mode === 'LEXICAL'
                    ? score.lexicalRank !== null && score.vectorRank === null
                    : offer.mode === 'VECTOR'
                      ? score.vectorRank !== null && score.lexicalRank === null
                      : score.lexicalRank !== null ||
                        score.vectorRank !== null),
            'LOAD_OBS_SEARCH_SCORES'
        );
        need(
            typeof row.source?.receipt === 'string' &&
                row.source.receipt.length > 0 &&
                row.source.receipt.length <= 4096 &&
                Number.isFinite(new Date(row.source.expiresAt).getTime()),
            'LOAD_OBS_SEARCH_SOURCE'
        );
    }
    const selected = value.results[0],
        eligibleDocuments = [...map.values()].filter((doc) =>
            eligible(doc, input.filters, types[offer.organization])
        ),
        eligibleChildren = eligibleDocuments.reduce(
            (sum, doc) =>
                sum +
                (doc.childCount ??
                    [...doc.chunks.values()].filter(
                        (chunk) => chunk.kind === 'CHILD'
                    ).length),
            0
        );
    return {
        source: selected
            ? {
                  organization: offer.organization,
                  collectionId: input.collectionId,
                  documentId: selected.documentId,
                  version: 1,
                  receipt: selected.source.receipt,
                  source: structuredClone(selected.sourceSpans[0]?.source),
              }
            : null,
        safe: {
            requestSha256: digest(input),
            generationId: report.generationId,
            results: value.results.length,
            eligibleDocuments: eligibleDocuments.length,
            eligibleChildren,
            unfiltered: Object.keys(input.filters).length === 0,
            lexicalPositiveControl: lexicalPositiveControl(
                offer,
                input.filters,
                value.results,
                { controls, map, types: types[offer.organization] }
            ),
            selective: offer.selectiveFilter === true,
            vectorUnderfilled: value.vectorUnderfilled,
            parentUnderfilled: value.parentUnderfilled ?? null,
        },
    };
}
/** Gold anchors stay frozen; cross-language relevance does not invent literal lexical-positive controls. */
export function createLexicalControls(references, map) {
    need(
        Array.isArray(references.queries) &&
            references.queries.length === 40 &&
            Array.isArray(references.qrels) &&
            references.qrels.length === 40 &&
            new Set(references.qrels.map((row) => row.queryId)).size === 40,
        'LOAD_OBS_LEXICAL_CONTROL'
    );
    const controls = new Map();
    references.queries.forEach((query, ordinal) => {
        if (query.category !== 'EXACT') return;
        const qrel = references.qrels.find((row) => row.queryId === query.id);
        need(
            qrel &&
                Array.isArray(qrel.editions) &&
                qrel.editions.length > 0 &&
                qrel.editions.length <= 24,
            'LOAD_OBS_LEXICAL_CONTROL'
        );
        const editions = [];
        for (const edition of qrel.editions) {
            const doc = [...map.values()].find(
                (row) => row.fixtureId === edition.fixtureId
            );
            need(
                doc &&
                    edition.version === 1 &&
                    sha(doc.artifact.text) === edition.canonicalSha256 &&
                    Array.isArray(edition.spans) &&
                    edition.spans.length > 0 &&
                    edition.spans.length <= 20,
                'LOAD_OBS_LEXICAL_CONTROL'
            );
            for (const span of edition.spans)
                need(
                    Number.isSafeInteger(span.startOffset) &&
                        Number.isSafeInteger(span.endOffset) &&
                        span.startOffset >= 0 &&
                        span.endOffset > span.startOffset &&
                        span.endOffset <= doc.artifact.text.length &&
                        sha(
                            doc.artifact.text.slice(
                                span.startOffset,
                                span.endOffset
                            )
                        ) === span.textSha256,
                    'LOAD_OBS_LEXICAL_CONTROL'
                );
            if (doc.language === query.language) {
                need(
                    edition.spans.some((span) =>
                        [...doc.chunks.values()].some(
                            (chunk) =>
                                chunk.kind === 'CHILD' &&
                                chunk.startOffset <= span.startOffset &&
                                chunk.endOffset >= span.endOffset
                        )
                    ),
                    'LOAD_OBS_LEXICAL_CONTROL_CHILD'
                );
                editions.push({
                    documentId: doc.documentId,
                    spans: edition.spans.map(({ startOffset, endOffset }) => ({
                        startOffset,
                        endOffset,
                    })),
                });
            }
        }
        need(editions.length > 0, 'LOAD_OBS_LEXICAL_CONTROL');
        controls.set(ordinal, { queryId: query.id, editions });
    });
    need(controls.size === 10, 'LOAD_OBS_LEXICAL_CONTROL');
    return controls;
}
/** Applies only to existing lexical EXACT positives retained by current typed/document filters; native modes have no recall gate. */
export function lexicalPositiveControl(
    offer,
    filters,
    results,
    { controls, map, types }
) {
    if (
        offer.organization !== 'B' ||
        offer.mode !== 'LEXICAL' ||
        !controls?.has(offer.queryOrdinal)
    )
        return { eligible: false, hit: null };
    const control = controls.get(offer.queryOrdinal),
        editions = control.editions.filter((edition) =>
            eligible(map.get(edition.documentId), filters, types)
        );
    if (!editions.length) return { eligible: false, hit: null };
    const hit = results.some((row) =>
        editions.some(
            (edition) =>
                edition.documentId === row.documentId &&
                edition.spans.some(
                    (span) =>
                        row.startOffset <= span.startOffset &&
                        row.endOffset >= span.endOffset
                )
        )
    );
    return { eligible: true, hit };
}
