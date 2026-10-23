/** Local synthetic source/planner preparation only. No runtime, network or catalog client. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    decodeStoredExtraction,
    structuredExtraction,
} from '../../../packages/documents/src/index.ts';
import {
    planParentContext,
    resolveChunkingStrategy,
} from '../../../packages/chunking/src/index.ts';
import { prepareEmbeddingInput } from '../../../packages/embeddings/src/preparation.ts';

export const RUNTIME_DRAFT_ONLY = true;
import {
    VERSION,
    SEED,
    NAMESPACE,
    POLICY_VERSION,
    PROFILE,
    PARENT_PROFILE,
    MODEL_REQUIREMENT,
    LIMITS,
    CONTROL_PROFILE,
    RESOURCE_LIMITS,
    FINITE_GATES,
} from './load-light-policy.mjs';
export { VERSION, SEED, PROFILE, PARENT_PROFILE, MODEL_REQUIREMENT, LIMITS };
// This nonbinding value formats the actual preset without asserting observed model context.
// The resulting maximum prepared bytes + 32 is an explicit later native-probe prerequisite.
const FORMATTING_ONLY_IDENTITY = Object.freeze({
    contextTokens: 65_536,
    preset: 'EMBEDDING_GEMMA',
});
export const TOPICS = Object.freeze(
    [
        {
            id: 'returns',
            EN: 'Returns require a receipt and a dated inspection.',
            FR: 'Le retour exige un reçu et un contrôle daté.',
        },
        {
            id: 'renewals',
            EN: 'Renewal keeps the recorded tariff after confirmation.',
            FR: 'Le renouvellement conserve le tarif après confirmation.',
        },
        {
            id: 'support',
            EN: 'Support records the priority and acknowledgment.',
            FR: 'Le support note la priorité et la réception du ticket.',
        },
        {
            id: 'backups',
            EN: 'Backup records retain a schedule and restore check.',
            FR: 'La sauvegarde garde une échéance et un contrôle.',
        },
        {
            id: 'delivery',
            EN: 'Delivery records contain the region and parcel tier.',
            FR: 'La livraison note la région et le niveau du colis.',
        },
        {
            id: 'equipment',
            EN: 'Equipment returns use a reception desk and form.',
            FR: 'Le matériel utilise un accueil et un formulaire.',
        },
        {
            id: 'travel',
            EN: 'Travel claims retain a deadline and expense cap.',
            FR: 'Le voyage conserve une échéance et un plafond.',
        },
        {
            id: 'coldchain',
            EN: 'Food sensors record temperature and calibration.',
            FR: 'Le capteur note température et étalonnage.',
        },
    ].map((topic) => Object.freeze(topic))
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const json = (value) => JSON.stringify(value);
const need = (condition, code) => {
    if (!condition) throw new Error(code);
};
const sourcePrefix = (index) => `${VERSION}-d${String(index).padStart(4, '0')}`;

/** Geometry controls are deliberately finite; no arbitrary document size or amplification. */
export function documentSpec(index, children = LIMITS.childrenPerDocument) {
    need(
        Number.isSafeInteger(index) && index >= 1 && index <= LIMITS.documents,
        'LOAD_DOCUMENT_BOUND'
    );
    need(
        Number.isSafeInteger(children) &&
            children >= 1 &&
            children <= LIMITS.childrenPerDocument,
        'LOAD_CHILD_BOUND'
    );
    const language = index % 2 === 1 ? 'EN' : 'FR';
    const topic = TOPICS[Math.floor((index - 1) / 2) % TOPICS.length];
    const target = PROFILE.targetTokens * 3;
    const stride = target - PROFILE.overlapTokens * 3;
    const bytes = target + (children - 1) * stride;
    need(bytes % 48 === 0 && bytes <= LIMITS.sourceBytes, 'LOAD_SOURCE_BOUND');
    return {
        index,
        id: sourcePrefix(index),
        filename: `${sourcePrefix(index)}-${language.toLowerCase()}.txt`,
        language,
        topic: topic.id,
        children,
        bytes,
        fullRecords: Math.floor(bytes / LIMITS.recordBytes),
        tailBytes: bytes % LIMITS.recordBytes,
        records: Math.ceil(bytes / LIMITS.recordBytes),
    };
}

/** Full 192-byte records and an explicit useful 0/48/96/144-byte final record preserve exact light-family coverage. */
export function buildDocument(spec) {
    assert.deepEqual(spec, documentSpec(spec.index, spec.children));
    const language = spec.language;
    const records = [];
    for (let index = 0; index < spec.fullRecords; index++) {
        const topic =
            TOPICS[(Math.floor((spec.index - 1) / 2) + index) % TOPICS.length];
        const value = hash(`${VERSION}|${SEED}|${spec.index}|${index}`).slice(
            0,
            12
        );
        const marker = `${spec.id}-r${String(index + 1).padStart(6, '0')}`;
        const unicode =
            language === 'FR'
                ? 'Café cafe\u0301 🧭.'
                : 'Recorded synthetic example.';
        const core = `${marker} ${language} ${topic.id} ${topic[language]} ${unicode} Value ${value}. `;
        const remaining = LIMITS.recordBytes - 1 - Buffer.byteLength(core);
        need(remaining >= 1, 'LOAD_RECORD_OVERFLOW');
        const padding =
            ' stable context'
                .repeat(Math.ceil(remaining / 15))
                .slice(0, remaining - 1) + 'z';
        const record = core + padding + '\n';
        need(
            Buffer.byteLength(record) === LIMITS.recordBytes,
            'LOAD_RECORD_LENGTH'
        );
        records.push(record);
    }
    if (spec.tailBytes) {
        const value = hash(`${VERSION}|${SEED}|${spec.index}|tail`).slice(
            0,
            12
        );
        const marker = `LIGHT_END D${String(spec.index).padStart(4, '0')} ${language} ${value}`;
        need(Buffer.byteLength(marker) < spec.tailBytes, 'LIGHT_TAIL_BOUND');
        records.push(marker.padEnd(spec.tailBytes - 1, 'x') + '\n');
    }
    const text = records.join('');
    need(Buffer.byteLength(text) === spec.bytes, 'LOAD_DOCUMENT_LENGTH');
    return text;
}

/** Exhaust the real saved-version planner and parent helper before accepting geometry. */
export function planDocument(
    index,
    children = LIMITS.childrenPerDocument,
    inputCap = PROFILE.maxEmbeddingInputBytes
) {
    const spec = documentSpec(index, children),
        text = buildDocument(spec);
    need(
        Number.isSafeInteger(inputCap) &&
            inputCap >= PROFILE.targetTokens * 3 &&
            inputCap <= PROFILE.maxEmbeddingInputBytes,
        'LOAD_INPUT_CAP'
    );
    const bytes = Buffer.from(text);
    const artifact = structuredExtraction.parse(
        decodeStoredExtraction(bytes, 'utf8-text-v1')
    );
    const strategy = resolveChunkingStrategy(
        'TOKEN_WINDOW',
        'token-window-utf8-v1'
    );
    const rows = [
        ...strategy.plan(artifact, {
            ...PROFILE,
            maxEmbeddingInputBytes: inputCap,
        }),
    ];
    need(rows.length === children, 'LOAD_PLANNED_COUNT');
    const parents = planParentContext(artifact, rows, PARENT_PROFILE);
    return {
        spec,
        text,
        bytes,
        artifact,
        rows,
        parents,
        chunkerVersion: strategy.version,
    };
}

/** Stream document plans; retain at most 100k hashes per distinctness set, never 100k texts/vectors. */
export function preflight({
    documentCount,
    childrenPerDocument = LIMITS.childrenPerDocument,
    onDocument,
} = {}) {
    need(
        Number.isSafeInteger(documentCount) &&
            documentCount >= 1 &&
            documentCount <= LIMITS.documents,
        'LOAD_DOCUMENT_COUNT'
    );
    need(
        Number.isSafeInteger(childrenPerDocument) &&
            childrenPerDocument >= 1 &&
            childrenPerDocument <= LIMITS.childrenPerDocument,
        'LOAD_CHILD_BOUND'
    );
    need(
        documentCount * childrenPerDocument <= LIMITS.totalChildren,
        'LOAD_TOTAL_BOUND'
    );
    need(
        onDocument === undefined || typeof onDocument === 'function',
        'LOAD_LOCAL_CALLBACK'
    );
    const childHashes = new Set(),
        inputHashes = new Set(),
        documents = [];
    const totals = {
        documents: 0,
        children: 0,
        parents: 0,
        sourceBytes: 0,
        childBytes: 0,
        parentBytes: 0,
        preparedInputBytes: 0,
        estimatedInputTokens: 0,
        workerBatches64: 0,
        maximumSourceBytes: 0,
        maximumPreparedInputBytes: 0,
        minimumChildBytes: Number.MAX_SAFE_INTEGER,
        maximumChildBytes: 0,
        maximumCombinedLayoutBytes: 0,
        maximumSourceSpansPerRow: 0,
    };
    const languages = { EN: 0, FR: 0 },
        primaryTopics = Object.fromEntries(
            TOPICS.map((topic) => [topic.id, 0])
        );
    for (let index = 1; index <= documentCount; index++) {
        const planned = planDocument(index, childrenPerDocument);
        const { spec, text, rows, parents } = planned;
        const geometry = createHash('sha256'),
            parentGeometry = createHash('sha256');
        let childBytes = 0,
            parentBytes = 0,
            preparedBytes = 0,
            estimatedTokens = 0,
            previousStart = -1,
            geometryOrdinal = 0;
        for (const row of rows) {
            need(
                row.ordinal === geometryOrdinal &&
                    row.start > previousStart &&
                    row.end > row.start &&
                    text.slice(row.start, row.end) === row.text &&
                    row.sourceSpans.length === 1 &&
                    row.sourceSpans[0].start === row.start &&
                    row.sourceSpans[0].end === row.end,
                'LOAD_CANONICAL_GEOMETRY'
            );
            previousStart = row.start;
            const textBytes = Buffer.byteLength(row.text),
                textHash = hash(row.text);
            need(!childHashes.has(textHash), 'LOAD_DUPLICATE_CHILD_TEXT');
            childHashes.add(textHash);
            const prepared = prepareEmbeddingInput(
                FORMATTING_ONLY_IDENTITY,
                'document',
                row.text,
                {
                    title: spec.filename,
                    preparation: MODEL_REQUIREMENT.preparation,
                }
            );
            const preparedSize = Buffer.byteLength(prepared),
                preparedHash = hash(prepared);
            need(
                !inputHashes.has(preparedHash) &&
                    preparedSize <= PROFILE.maxEmbeddingInputBytes,
                'LOAD_DUPLICATE_OR_OVERSIZED_INPUT'
            );
            inputHashes.add(preparedHash);
            need(
                childHashes.size <= LIMITS.totalChildren &&
                    inputHashes.size <= LIMITS.totalChildren,
                'LOAD_HASH_SET_BOUND'
            );
            need(
                row.tokenCountIsEstimate &&
                    row.tokenCount === Math.ceil(textBytes / 3),
                'LOAD_TOKEN_ESTIMATE'
            );
            geometry.update(
                json([
                    row.ordinal,
                    row.start,
                    row.end,
                    textHash,
                    preparedHash,
                    row.sourceSpans.map((span) => [
                        span.source.index,
                        span.start,
                        span.end,
                    ]),
                ]) + '\n'
            );
            childBytes += textBytes;
            preparedBytes += preparedSize;
            estimatedTokens += Math.ceil(preparedSize / 4);
            totals.minimumChildBytes = Math.min(
                totals.minimumChildBytes,
                textBytes
            );
            totals.maximumChildBytes = Math.max(
                totals.maximumChildBytes,
                textBytes
            );
            totals.maximumPreparedInputBytes = Math.max(
                totals.maximumPreparedInputBytes,
                preparedSize
            );
            totals.maximumSourceSpansPerRow = Math.max(
                totals.maximumSourceSpansPerRow,
                row.sourceSpans.length
            );
            geometryOrdinal++;
        }
        for (const parent of parents.parents) {
            parentBytes += Buffer.byteLength(parent.text);
            parentGeometry.update(
                json([
                    parent.ordinal,
                    parent.start,
                    parent.end,
                    hash(parent.text),
                ]) + '\n'
            );
        }
        const entry = {
            ...spec,
            sourceSha256: hash(planned.bytes),
            canonicalSha256: hash(text),
            utf16Units: text.length,
            sourceCount: planned.artifact.sources.length,
            chunkerVersion: planned.chunkerVersion,
            parentContextVersion: parents.version,
            actualChildren: rows.length,
            actualParents: parents.parents.length,
            childBytes,
            parentBytes,
            preparedInputBytes: preparedBytes,
            estimatedInputTokens: estimatedTokens,
            geometrySha256: geometry.digest('hex'),
            parentGeometrySha256: parentGeometry.digest('hex'),
            childParentMappingSha256: hash(json(parents.childParentOrdinals)),
        };
        // A callback may only write the already-generated local source; no callback is used by tests.
        onDocument?.(entry, planned.bytes);
        documents.push(entry);
        languages[spec.language]++;
        primaryTopics[spec.topic]++;
        totals.documents++;
        totals.children += rows.length;
        totals.parents += parents.parents.length;
        totals.sourceBytes += planned.bytes.length;
        totals.childBytes += childBytes;
        totals.parentBytes += parentBytes;
        totals.preparedInputBytes += preparedBytes;
        totals.estimatedInputTokens += estimatedTokens;
        totals.workerBatches64 += Math.ceil(rows.length / 64);
        totals.maximumSourceBytes = Math.max(
            totals.maximumSourceBytes,
            planned.bytes.length
        );
        totals.maximumCombinedLayoutBytes = Math.max(
            totals.maximumCombinedLayoutBytes,
            childBytes + parentBytes
        );
    }
    need(
        childHashes.size === totals.children &&
            inputHashes.size === totals.children,
        'LOAD_DISTINCTNESS_COUNT'
    );
    const family = {
        version: VERSION,
        seed: SEED,
        policyVersion: POLICY_VERSION,
        controlProfile: CONTROL_PROFILE,
        resourceLimits: RESOURCE_LIMITS,
        finiteGates: FINITE_GATES,
        recordBytes: LIMITS.recordBytes,
        topics: TOPICS,
        profile: PROFILE,
        parentProfile: PARENT_PROFILE,
        modelRequirement: MODEL_REQUIREMENT,
    };
    const result = {
        formatVersion: 1,
        namespace: NAMESPACE,
        version: VERSION,
        seed: SEED,
        status: 'PURE_GEOMETRY_PREPARED_NATIVE_CAPACITY_NOT_RUN',
        runtimeDraftOnly: RUNTIME_DRAFT_ONLY,
        familySha256: hash(json(family)),
        ...family,
        totals,
        languages,
        primaryTopics,
        documents,
        distinctChildTexts: childHashes.size,
        distinctPreparedInputs: inputHashes.size,
        minimumVerifiedContextTokensForPreparedInputs:
            totals.maximumPreparedInputBytes + 32,
        rawFloat32VectorBytesAt768: totals.children * 768 * 4,
        actualProviderCalls: 0,
        databaseCalls: 0,
        httpCalls: 0,
        capacityAcceptance: 'NOT_RUN',
        limitations: [
            'Pure planner geometry and source hashes, not actual uploads, publications, vectors or indexing throughput.',
            'Preparation formatting uses a nonbinding local context; native probe must independently verify saved model identity/context and byte budget.',
            'Child counts use UTF8/3 estimates; native estimated work uses ceil(prepared input bytes/4). Neither is an exact model tokenizer or billing count.',
            'Primary A is light; reference B and both ingestion controls retain the original declared profile.',
            'Deterministic ID/value variation proves byte-distinct inputs; templated related prose is not representative production semantic diversity.',
            'Reference quality corpus/qrels/profiles/gates are unchanged and are not measured by this load generator.',
            'Raw vector/text bytes exclude indexes, WAL, tuple/JSON overhead, parents, temporary rebuilds, logs and multiple physical copies.',
        ],
    };
    result.corpusSha256 = hash(
        json({ familySha256: result.familySha256, documents })
    );
    return result;
}
