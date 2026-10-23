/** Local synthetic source/planner preparation only. No runtime, network or catalog client. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
export const VERSION = 'm7c-load-v1';
export const SEED = 'vectorix-m7c-load-default-2026-10-23-v1';
export const PROFILE = Object.freeze({
    targetTokens: 512,
    minTokens: 128,
    maxTokens: 768,
    overlapTokens: 64,
    maxEmbeddingInputBytes: 6144,
    maxChunks: 100_000,
});
export const PARENT_PROFILE = Object.freeze({ parentMaxTokens: 2048 });
export const MODEL_REQUIREMENT = Object.freeze({
    provider: 'OLLAMA',
    model: 'embeddinggemma:latest',
    dimensions: 768,
    preset: 'EMBEDDING_GEMMA',
    preparation: '',
    metric: 'COSINE',
    numericType: 'FLOAT32',
    indexType: 'DISKANN',
    parentChild: true,
    expectedDigest:
        '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
});
export const LIMITS = Object.freeze({
    documents: 200,
    childrenPerDocument: 500,
    totalChildren: 100_000,
    sourceBytes: 25 * 1024 ** 2,
    recordBytes: 192,
    pilotDocuments: 4,
    originalSourceBytes: 134_438_400,
});
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
const BASE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(BASE, '../../..');
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
    need(
        bytes % LIMITS.recordBytes === 0 && bytes <= LIMITS.sourceBytes,
        'LOAD_SOURCE_BOUND'
    );
    return {
        index,
        id: sourcePrefix(index),
        filename: `${sourcePrefix(index)}-${language.toLowerCase()}.txt`,
        language,
        topic: topic.id,
        children,
        bytes,
        records: bytes / LIMITS.recordBytes,
    };
}

/** Each fixed-byte record contains unique document/record IDs and seeded, nonsecret values. */
export function buildDocument(spec) {
    assert.deepEqual(spec, documentSpec(spec.index, spec.children));
    const language = spec.language;
    const records = [];
    for (let index = 0; index < spec.records; index++) {
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
            estimatedTokens += Math.ceil(preparedSize / 3);
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
        recordBytes: LIMITS.recordBytes,
        topics: TOPICS,
        profile: PROFILE,
        parentProfile: PARENT_PROFILE,
        modelRequirement: MODEL_REQUIREMENT,
    };
    const result = {
        formatVersion: 1,
        namespace: 'vectorix-m7c-load',
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
            'UTF-8/3 counts are estimates, not native model tokenizer/billing counts.',
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

function privateOutput(filename, value) {
    const bytes =
        typeof value === 'string' || Buffer.isBuffer(value)
            ? value
            : json(value) + '\n';
    const fd = fs.openSync(
        filename,
        fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    try {
        fs.writeFileSync(fd, bytes);
    } finally {
        fs.closeSync(fd);
    }
}

/** Explicit local-only CLI; source generation is opt-in and never launches another process. */
function main() {
    const args = process.argv.slice(2);
    need(
        args.length === 4 &&
            args[0] === '--scale' &&
            ['pilot', 'full'].includes(args[1]) &&
            args[2] === '--mode' &&
            ['preflight', 'sources'].includes(args[3]),
        'LOAD_ARGUMENTS'
    );
    const scale = args[1],
        mode = args[3],
        parent = path.join(BASE, 'load-v1');
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { mode: 0o700 });
    const parentStat = fs.lstatSync(parent);
    need(
        fs.realpathSync(parent) === parent &&
            parentStat.isDirectory() &&
            !parentStat.isSymbolicLink() &&
            parentStat.uid === process.getuid() &&
            (parentStat.mode & 0o777) === 0o700,
        'LOAD_PRIVATE_OUTPUT'
    );
    let sourceDirectory;
    if (mode === 'sources') {
        sourceDirectory = path.join(parent, scale);
        fs.mkdirSync(sourceDirectory, { mode: 0o700 });
    }
    const proof = preflight({
        documentCount:
            scale === 'pilot' ? LIMITS.pilotDocuments : LIMITS.documents,
        ...(sourceDirectory
            ? {
                  onDocument: (entry, bytes) =>
                      privateOutput(
                          path.join(sourceDirectory, entry.filename),
                          bytes
                      ),
              }
            : {}),
    });
    proof.localToolSha256 = hash(
        fs.readFileSync(fileURLToPath(import.meta.url))
    );
    proof.productionSourceHashes = Object.fromEntries(
        [
            ...fs
                .readdirSync(path.join(ROOT, 'packages/chunking/src'))
                .filter((name) => name.endsWith('.ts'))
                .sort()
                .map((name) => `packages/chunking/src/${name}`),
            'packages/documents/src/index.ts',
            'packages/embeddings/src/preparation.ts',
        ].map((name) => [name, hash(fs.readFileSync(path.join(ROOT, name)))])
    );
    const file = sourceDirectory
        ? path.join(sourceDirectory, 'manifest.json')
        : path.join(parent, `${scale}-preflight.json`);
    privateOutput(file, proof);
    console.log(
        json({
            completed: true,
            evidenceKind: 'LOCAL_PURE_PLANNER',
            scale,
            mode,
            corpusSha256: proof.corpusSha256,
            children: proof.totals.children,
            documents: proof.totals.documents,
            parents: proof.totals.parents,
            distinctChildTexts: proof.distinctChildTexts,
            distinctPreparedInputs: proof.distinctPreparedInputs,
            actualProviderCalls: 0,
            capacityAcceptance: 'NOT_RUN',
            output: file,
        })
    );
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    try {
        main();
    } catch (error) {
        console.error(
            json({
                completed: false,
                diagnostic: /^LOAD_[A-Z_]+$/u.test(error?.message)
                    ? error.message
                    : 'LOAD_LOCAL_PREPARATION_FAILED',
            })
        );
        process.exitCode = 1;
    }
}
