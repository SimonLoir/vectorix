#!/usr/bin/env node
/** Local CPU/file preflight only. No service, provider, database, container or application process is started. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    buildSource,
    FILE_NAME,
    UNIT_COUNT,
    UNIT_TARGET_BYTES,
    PROFILE,
    PREPARATION_CONTRACT,
} from './fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sha = (value) => createHash('sha256').update(value).digest('hex');
const need = (condition) => {
    if (!condition) throw new Error('FIXTURE_REFUSED');
};
const SOURCE_PATHS = [
    'packages/documents/src/index.ts',
    'packages/routers/rag/src/services/documents/extract.ts',
    'packages/chunking/src/semantic-units.ts',
    'packages/chunking/src/semantic-plan.ts',
    'packages/chunking/src/parent-context.ts',
    'packages/embeddings/src/preparation.ts',
];
export function workspaceRoot(directory = HERE) {
    for (let depth = 0; depth < 7; depth++, directory = path.dirname(directory))
        if (
            fs.existsSync(path.join(directory, 'pnpm-workspace.yaml')) &&
            fs.existsSync(
                path.join(directory, 'packages/documents/src/index.ts')
            )
        )
            return directory;
    throw new Error('FIXTURE_REFUSED');
}
export async function loadProduction(root = workspaceRoot()) {
    const require = createRequire(path.join(root, 'apps/api/package.json'));
    const { tsImport } = await import(
        pathToFileURL(require.resolve('tsx/esm/api')).href
    );
    const [documents, extraction, chunking, embeddings] = await Promise.all(
        [
            'packages/documents/src/index.ts',
            'packages/routers/rag/src/services/documents/extract.ts',
            'packages/chunking/src/index.ts',
            'packages/embeddings/src/preparation.ts',
        ].map((name) =>
            tsImport(pathToFileURL(path.join(root, name)).href, import.meta.url)
        )
    );
    return { documents, extraction, chunking, embeddings };
}
/** A preparation contract is not an archived native identity or a successful provider probe. */
export function createPreflight(modules, contract = PREPARATION_CONTRACT) {
    need(
        contract &&
            contract.preset === 'EMBEDDING_GEMMA' &&
            Number.isSafeInteger(contract.contextTokens)
    );
    const { documents, extraction, chunking, embeddings } = modules,
        original = Buffer.from(buildSource(), 'utf8'),
        extracted = extraction.extractText(original, sha(original)),
        artifact = documents.structuredExtraction.parse(
            documents.decodeStoredExtraction(extracted, 'utf8-text-v1')
        ),
        maxEmbeddingInputBytes = Math.min(
            49152,
            embeddings.embeddingInputByteLimit(contract, {
                title: FILE_NAME,
                preparation: '',
                kind: 'document',
            })
        ),
        options = {
            ...PROFILE,
            semanticPercentile: 90,
            maxEmbeddingInputBytes,
            maxChunks: 5000,
        },
        units = chunking.unitizeSemantic(artifact, options),
        unitManifestHash = chunking.semanticUnitManifestHash(
            artifact,
            units,
            options
        );
    need(
        original.length < 25 * 1024 ** 2 &&
            original.equals(extracted) &&
            artifact.text === original.toString('utf8') &&
            units.length === UNIT_COUNT
    );
    chunking.validateSemanticUnits(artifact, units, unitManifestHash, options);
    const unitRecords = units.map((unit) => {
        const text = artifact.text.slice(unit.start, unit.end),
            prepared = embeddings.prepareEmbeddingInput(
                contract,
                'document',
                text,
                { title: FILE_NAME, preparation: '' }
            );
        need(
            !/[.!?。！？\r\n]/u.test(text) &&
                Buffer.byteLength(text) <= UNIT_TARGET_BYTES
        );
        return {
            ...unit,
            utf8Bytes: Buffer.byteLength(text),
            textSha256: sha(text),
            preparedBytes: Buffer.byteLength(prepared),
            preparedInputSha256: sha(prepared),
        };
    });
    need(
        new Set(unitRecords.map((unit) => unit.textSha256)).size ===
            UNIT_COUNT &&
            new Set(unitRecords.map((unit) => unit.preparedInputSha256))
                .size === UNIT_COUNT
    );
    const cases = [];
    for (const percentile of [90, 55])
        for (const scenario of [
            'ALL_ZERO',
            'POSITIVE_TIES',
            'VARIED_SYNTHETIC',
        ]) {
            const distances = Array.from(
                    { length: units.length - 1 },
                    (_, index) =>
                        scenario === 'ALL_ZERO'
                            ? 0
                            : scenario === 'POSITIVE_TIES'
                              ? 1000000
                              : 1 +
                                (parseInt(
                                    unitRecords[index].textSha256.slice(0, 6),
                                    16
                                ) %
                                    2000000)
                ),
                semantic = { units, distances, unitManifestHash },
                settings = { ...options, semanticPercentile: percentile },
                chunks = [
                    ...chunking.chunkDocumentSemantic(
                        artifact,
                        settings,
                        semantic
                    ),
                ],
                ranges = chunks.map(({ ordinal, start, end }) => ({
                    ordinal,
                    start,
                    end,
                })),
                planHash = chunking.semanticPlanHash(
                    semantic,
                    settings,
                    ranges
                ),
                parents = chunking.planParentContext(artifact, chunks, {
                    parentMaxTokens: PROFILE.parentMaxTokens,
                });
            chunking.validateSemanticPlan(
                artifact,
                settings,
                semantic,
                ranges,
                planHash
            );
            let preparedBytes = 0,
                maximumChildPreparedBytes = 0;
            for (const child of chunks) {
                need(
                    child.text === artifact.text.slice(child.start, child.end)
                );
                const prepared = embeddings.prepareEmbeddingInput(
                    contract,
                    'document',
                    child.text,
                    { title: FILE_NAME, preparation: '' }
                );
                preparedBytes += Buffer.byteLength(prepared);
                maximumChildPreparedBytes = Math.max(
                    maximumChildPreparedBytes,
                    Buffer.byteLength(prepared)
                );
            }
            need(
                chunks.length > 0 &&
                    chunks.length <= 5000 &&
                    parents.parents.length > 0
            );
            cases.push({
                percentile,
                scenario,
                scoreEvidence: 'SYNTHETIC_NOT_NATIVE',
                distancesSha256: sha(JSON.stringify(distances)),
                planHash,
                children: chunks.length,
                parents: parents.parents.length,
                layoutSha256: sha(JSON.stringify(parents)),
                maximumChildPreparedBytes,
                finalPreparedBytes: preparedBytes,
            });
        }
    const proof = {
        schemaVersion: 1,
        fixture: 'M7C_SINGLE_BOUNDARY_INTERRUPTION_V1',
        evidenceKind: 'OFFLINE_PRODUCTION_FUNCTIONS',
        nativeAcceptance: 'NOT_RUN',
        identityEvidence: 'EXPLICIT_PREPARATION_CONTRACT_NOT_NATIVE_IDENTITY',
        fileName: FILE_NAME,
        extractorVersion: 'utf8-text-v1',
        offsetUnit: 'UTF16_CODE_UNITS',
        hashEncoding: 'UTF8_SHA256',
        originalBytes: original.length,
        sourceSha256: sha(original),
        canonicalSha256: sha(artifact.text),
        canonicalUtf16Units: artifact.text.length,
        artifactSha256: sha(JSON.stringify(artifact)),
        preparationContract: { ...contract, title: FILE_NAME, preparation: '' },
        usefulTextByteCap: maxEmbeddingInputBytes,
        unitizerVersion: chunking.SEMANTIC_UNITIZER_VERSION,
        chunkerVersion: chunking.SEMANTIC_CHUNKER_VERSION,
        unitCount: units.length,
        unitManifestHash,
        maximumUnitBytes: Math.max(
            ...unitRecords.map((unit) => unit.utf8Bytes)
        ),
        maximumPreparedUnitBytes: Math.max(
            ...unitRecords.map((unit) => unit.preparedBytes)
        ),
        boundaryPreparedBytes: unitRecords.reduce(
            (sum, unit) => sum + unit.preparedBytes,
            0
        ),
        profile: PROFILE,
        nativeBoundaryDistances: 'UNKNOWN',
        nativeTiming: 'UNMEASURED',
        freshProbeRequiredBeforeCost: true,
        units: unitRecords,
        geometryCases: cases,
    };
    return { original, artifact, proof };
}
/** Recheck supplied fresh reply metadata locally; this function never performs or attests to the API call. */
export function validateSuppliedProbe(modules, probe) {
    need(
        probe?.provider === 'OLLAMA' &&
            probe.model === 'embeddinggemma:latest' &&
            probe.preset === 'EMBEDDING_GEMMA' &&
            Number.isSafeInteger(probe.contextTokens) &&
            typeof probe.digest === 'string' &&
            /^(?:sha256:)?[a-f0-9]{64}$/u.test(probe.digest) &&
            [128, 256, 512, 768].includes(probe.dimensions)
    );
    const { proof } = createPreflight(modules, {
        contextTokens: probe.contextTokens,
        preset: probe.preset,
    });
    need(proof.maximumUnitBytes <= proof.usefulTextByteCap);
    return {
        status: 'SUPPLIED_PROBE_METADATA_COMPATIBLE',
        provenance: 'NOT_PROBED_BY_THIS_TOOL',
        modelDigest: probe.digest,
        dimensions: probe.dimensions,
        contextTokens: probe.contextTokens,
        usefulTextByteCap: proof.usefulTextByteCap,
        maximumUnitBytes: proof.maximumUnitBytes,
        unitCount: proof.unitCount,
        unitManifestHash: proof.unitManifestHash,
        fileName: FILE_NAME,
        preparation: '',
        liveAdmission:
            'REQUIRES_CURRENT_SAVED_PROFILE_AND_GUARDED_NATIVE_PROBE',
    };
}
function writeExclusive(filename, bytes) {
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_WRONLY |
            fs.constants.O_NOFOLLOW,
        0o600
    );
    try {
        fs.writeFileSync(descriptor, bytes);
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}
/** Private probe files stay 0600; committed public fixtures may also use Git's 0644 checkout mode. */
export function readOwnedFile(
    filename,
    maximum,
    { publicFixture = false } = {}
) {
    need(
        Number.isSafeInteger(maximum) && maximum > 0 && maximum <= 2 * 1024 ** 2
    );
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const stat = fs.fstatSync(descriptor);
        need(
            stat.isFile() &&
                stat.uid === process.getuid() &&
                ((stat.mode & 0o777) === 0o600 ||
                    (publicFixture && (stat.mode & 0o777) === 0o644)) &&
                stat.size <= maximum
        );
        const bytes = Buffer.alloc(maximum + 1);
        let used = 0;
        while (used < bytes.length) {
            const read = fs.readSync(
                descriptor,
                bytes,
                used,
                bytes.length - used,
                null
            );
            if (!read) break;
            used += read;
        }
        need(used <= maximum);
        return bytes.subarray(0, used);
    } finally {
        fs.closeSync(descriptor);
    }
}
/** Verify the complete public fixture directory; do not apply these checkout modes to private probe input. */
export function verifyPreparedOutputs(directory, outputs) {
    const stat = fs.statSync(directory);
    need(
        fs.realpathSync(directory) === directory &&
            stat.isDirectory() &&
            stat.uid === process.getuid() &&
            [0o700, 0o755].includes(stat.mode & 0o777)
    );
    need(
        JSON.stringify(fs.readdirSync(directory).sort()) ===
            JSON.stringify(Object.keys(outputs).sort())
    );
    for (const [name, bytes] of Object.entries(outputs))
        need(
            readOwnedFile(path.join(directory, name), 2 * 1024 ** 2, {
                publicFixture: true,
            }).equals(bytes)
        );
}
export async function main(args = process.argv.slice(2)) {
    need(
        (args.length === 1 && ['generate', 'check'].includes(args[0])) ||
            (args.length === 2 && args[0] === 'check-probe')
    );
    const root = workspaceRoot(),
        modules = await loadProduction(root),
        prepared = createPreflight(modules),
        directory = path.join(HERE, 'prepared-v1'),
        productionSha256 = Object.fromEntries(
            SOURCE_PATHS.map((name) => [
                name,
                sha(fs.readFileSync(path.join(root, name))),
            ])
        ),
        fixtureSourceSha256 = Object.fromEntries(
            ['fixture.mjs', 'preflight.mjs'].map((name) => [
                name,
                sha(fs.readFileSync(path.join(HERE, name))),
            ])
        ),
        proof = { ...prepared.proof, productionSha256, fixtureSourceSha256 },
        outputs = {
            [FILE_NAME]: prepared.original,
            'canonical.json': Buffer.from(
                JSON.stringify(prepared.artifact) + '\n'
            ),
            'preflight.json': Buffer.from(
                JSON.stringify(proof, null, 2) + '\n'
            ),
        };
    if (args[0] === 'generate') {
        fs.mkdirSync(directory, { mode: 0o700 });
        for (const [name, bytes] of Object.entries(outputs))
            writeExclusive(path.join(directory, name), bytes);
        const descriptor = fs.openSync(
            directory,
            fs.constants.O_RDONLY |
                fs.constants.O_DIRECTORY |
                fs.constants.O_NOFOLLOW
        );
        try {
            fs.fsyncSync(descriptor);
        } finally {
            fs.closeSync(descriptor);
        }
    } else verifyPreparedOutputs(directory, outputs);
    if (args[0] === 'check-probe') {
        const filename = path.resolve(args[1]);
        need(
            filename.startsWith(
                path.join(root, 'node_modules/.cache/vectorix') + path.sep
            ) && fs.realpathSync(filename) === filename
        );
        const probe = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
                readOwnedFile(filename, 16384)
            )
        );
        return validateSuppliedProbe(modules, probe);
    }
    return {
        status: 'OFFLINE_FIXTURE_VALID',
        sourceSha256: proof.sourceSha256,
        preflightSha256: sha(outputs['preflight.json']),
        originalBytes: proof.originalBytes,
        unitCount: proof.unitCount,
        usefulTextByteCap: proof.usefulTextByteCap,
        maximumUnitBytes: proof.maximumUnitBytes,
        nativeAcceptance: 'NOT_RUN',
        nativeTiming: 'UNMEASURED',
    };
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
    main()
        .then((result) => console.log(JSON.stringify(result)))
        .catch(() => {
            console.error(
                JSON.stringify({
                    status: 'REFUSED',
                    diagnostic: 'FIXTURE_REFUSED',
                    nativeAcceptance: 'NOT_RUN',
                })
            );
            process.exitCode = 1;
        });
