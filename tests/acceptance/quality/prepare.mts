/** Local synthetic fixtures only. No application context, secrets, network or database. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    readFile,
    writeFile,
    mkdir,
    lstat,
    realpath,
    readdir,
} from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { workspaceRoot } from './workspace-root.mjs';
import { buildQueries, buildQrels, DEVELOPMENT_QUERIES } from './queries.mjs';

const root = workspaceRoot();
const localModule = (relative: string) =>
    import(pathToFileURL(path.join(root, relative)).href);
const { parsePdf } = await localModule('apps/workers/src/extraction/pdf.ts');
const { parseDocx } = await localModule('apps/workers/src/extraction/docx.ts');
const { decodeStoredExtraction, structuredExtraction } = await localModule(
    'packages/documents/src/index.ts'
);
const { resolveChunkingStrategy, planParentContext, unitizeSemantic } =
    await localModule('packages/chunking/src/index.ts');

assert(
    process.argv.length === 4 && process.argv[2] === '--directory',
    'Use --directory ABSOLUTE_PRIVATE_GENERATED_DIRECTORY'
);
const directory = process.argv[3]!;
const cache = path.join(root, 'node_modules/.cache/vectorix');
const info = await lstat(directory);
assert(
    path.isAbsolute(directory) &&
        (await realpath(directory)) === directory &&
        directory.startsWith(cache + path.sep) &&
        info.isDirectory() &&
        info.uid === process.getuid() &&
        (info.mode & 0o777) === 0o700,
    'PRIVATE_REGENERATION_DIRECTORY_REQUIRED'
);
assert.deepEqual(
    (await readdir(directory)).sort(),
    ['originals', 'source-manifest.json'],
    'REFUSE_NONEMPTY_PARSER_OUTPUT'
);
const hash = (value: string | Uint8Array) =>
    createHash('sha256').update(value).digest('hex');
const readJson = async (name: string) =>
    JSON.parse(await readFile(`${directory}/${name}`, 'utf8'));
const outputJson = async (name: string, value: unknown) =>
    writeFile(`${directory}/${name}`, `${JSON.stringify(value, null, 2)}\n`);
const manifest = await readJson('source-manifest.json');
await mkdir(`${directory}/canonical`, { recursive: true });
assert.equal(manifest.documents.length, 24);
const options = {
    targetTokens: 512,
    minTokens: 128,
    maxTokens: 768,
    overlapTokens: 64,
    maxEmbeddingInputBytes: 6144,
};
const geometry: unknown[] = [];
for (const document of manifest.documents) {
    const bytes = await readFile(`${directory}/${document.originalPath}`);
    assert.equal(hash(bytes), document.originalSha256);
    assert.equal(bytes.length, document.originalBytes);
    let artifact;
    if (document.mediaType === 'application/pdf')
        artifact = await parsePdf(bytes);
    else if (document.mediaType.includes('wordprocessingml'))
        artifact = await parseDocx(bytes);
    else {
        // Same utf8-text-v1 normalization as @routers/rag ingestion; no source binding is needed locally.
        const text = new TextDecoder('utf-8', { fatal: true })
            .decode(bytes)
            .replaceAll(/\r\n?/g, '\n');
        assert(!text.includes('\0') && /[\p{L}\p{N}]/u.test(text));
        artifact = decodeStoredExtraction(Buffer.from(text), 'utf8-text-v1');
        if (document.mediaType === 'text/markdown')
            artifact.format = 'MARKDOWN';
    }
    structuredExtraction.parse(artifact);
    const canonicalPath = `canonical/${document.fixtureId}.json`;
    await outputJson(canonicalPath, artifact);
    Object.assign(document, {
        canonicalStatus: 'CONFIRMED_LOCAL_PARSER',
        canonicalPath,
        canonicalOffsetUnit: 'UTF16_CODE_UNITS',
        canonicalSha256: hash(artifact.text),
        canonicalLength: artifact.text.length,
        canonicalUtf8Bytes: Buffer.byteLength(artifact.text),
        extractionFormat: artifact.format,
        goldSpans: Object.entries(document.anchors).map(([anchorId, text]) => {
            const literal = text as string;
            const startOffset = artifact.text.indexOf(literal);
            assert(
                startOffset >= 0,
                `${document.fixtureId}/${anchorId} absent from actual canonical extraction`
            );
            assert.equal(
                artifact.text.indexOf(literal, startOffset + 1),
                -1,
                'ambiguous anchor'
            );
            return {
                anchorId,
                startOffset,
                endOffset: startOffset + literal.length,
                textSha256: hash(literal),
            };
        }),
    });
    delete document.anchors;
    const record: Record<string, unknown> = { fixtureId: document.fixtureId };
    for (const strategy of ['DOCUMENT_STRUCTURE', 'TOKEN_WINDOW']) {
        const resolved = resolveChunkingStrategy(strategy);
        const children = [...resolved.plan(artifact, options)];
        const layout = planParentContext(artifact, children, {
            parentMaxTokens: 2048,
        });
        assert(children.length > 1);
        assert(
            children.every(
                (child) =>
                    child.text === artifact.text.slice(child.start, child.end)
            )
        );
        const covers = (
            range: { start: number; end: number },
            span: { startOffset: number; endOffset: number }
        ) => range.start <= span.startOffset && range.end >= span.endOffset;
        if (
            document.kind === 'CORE' &&
            ['F01', 'F04', 'F06', 'F07', 'F08'].includes(document.factFamily)
        ) {
            assert(
                !children.some((child) =>
                    document.goldSpans.every(
                        (span: { startOffset: number; endOffset: number }) =>
                            covers(child, span)
                    )
                ),
                'context question fits a single child'
            );
            assert(
                layout.parents.some((parent) =>
                    document.goldSpans.every(
                        (span: { startOffset: number; endOffset: number }) =>
                            covers(parent, span)
                    )
                ),
                'paired facts do not fit any parent'
            );
        }
        record[strategy] = {
            version: resolved.version,
            children: children.length,
            parents: layout.parents.length,
        };
    }
    const units = unitizeSemantic(artifact, {
        maxEmbeddingInputBytes: options.maxEmbeddingInputBytes,
    });
    record.SEMANTIC = {
        unitCount: units.length,
        nativeDistances: 'NOT_RUN',
        finalGeometry: 'NOT_RUN',
    };
    geometry.push(record);
}
assert.equal(
    manifest.documents.filter(
        (doc: { language: string }) => doc.language === 'FR'
    ).length,
    12
);
for (const mediaType of new Set(
    manifest.documents.map((doc: { mediaType: string }) => doc.mediaType)
)) {
    const entries = manifest.documents.filter(
        (doc: { mediaType: string }) => doc.mediaType === mediaType
    );
    assert.equal(entries.length, 6);
    assert.equal(
        entries.filter((doc: { language: string }) => doc.language === 'FR')
            .length,
        3
    );
}
const queries = buildQueries(manifest.documents);
const qrels = buildQrels(manifest.documents, queries);
const policy = {
    schemaVersion: 1,
    offsetUnit: 'UTF16_CODE_UNITS',
    canonicalHashEncoding: 'UTF8',
    model: {
        provider: 'OLLAMA',
        model: 'embeddinggemma:latest',
        dimensions: 768,
        preset: 'EMBEDDING_GEMMA',
        digest: '85462619ee721b466c5927d109d4cb765861907d5417b9109caebc4e614679f1',
        identityKind: 'WEIGHTS_DIGEST',
        distance: 'COSINE',
        vectorType: 'FLOAT32',
    },
    profile: {
        ...options,
        indexType: 'DISKANN',
        preparation: '',
        metadataFields: manifest.metadataFields,
        parentChild: true,
        parentMaxTokens: 2048,
        semanticPercentile: 90,
    },
    gates: {
        exactLexicalHit5: 10,
        hybridHit5: 32,
        hybridEachLanguageHit5: 16,
        hybridMrr10: 0.65,
        crossLanguageHybridHit5: 3,
        filterHybridHit5: 9,
        parentHybridHit5: 8,
        hardSafetyViolations: 0,
    },
    strategies: ['DOCUMENT_STRUCTURE', 'TOKEN_WINDOW', 'SEMANTIC'],
    modes: ['LEXICAL', 'VECTOR', 'HYBRID'],
    repeats: 2,
    captureLimits: {
        bytes: 8 * 1024 * 1024,
        queries: 720,
        resultsPerQuery: 10,
        sourceSpansPerPassage: 64,
    },
    capacityAcceptance: 'NOT_RUN',
    hostedProviderAcceptance: 'NOT_RUN',
    nativeQualityAcceptance: 'NOT_RUN',
};
const digestInput = { documents: manifest.documents, queries, qrels, policy };
const corpusDigest = hash(JSON.stringify(digestInput));
const poppler = spawnSync('/usr/bin/pdftotext', ['-v'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
});
assert.equal(poppler.status, 0);
const popplerVersion = `${poppler.stdout}${poppler.stderr}`.split('\n')[0];
const parserSourcePaths = [
    'apps/workers/src/extraction/pdf.ts',
    'apps/workers/src/extraction/docx.ts',
    'packages/documents/src/index.ts',
];
const parserSourceHashes = await Promise.all(
    parserSourcePaths.map(async (sourcePath) => ({
        sourcePath,
        sha256: hash(await readFile(path.join(root, sourcePath))),
    }))
);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
await outputJson('manifest.json', {
    ...manifest,
    corpusDigest,
    offsetUnit: policy.offsetUnit,
    canonicalHashEncoding: 'UTF8',
    status: 'CANONICAL_CONFIRMED_NOT_INDEXED',
    canonicalParser: {
        text: 'utf8-text-v1 LF normalization',
        pdf: 'production parsePdf /usr/bin Poppler',
        docx: 'production parseDocx',
        popplerVersion,
        parserSourceHashes,
    },
});
await outputJson('queries.json', queries);
await outputJson('qrels.json', qrels);
await outputJson('development-queries.json', DEVELOPMENT_QUERIES);
await outputJson('policy.json', policy);
await outputJson('geometry-preflight.json', {
    status: 'PURE_PLANNERS_ONLY',
    options,
    geometry,
    semanticNativeDistances: 'NOT_RUN',
});
await outputJson('canonical-proof.json', {
    status: 'CONFIRMED_LOCAL_PARSER',
    sourceCommit,
    corpusDigest,
    documents: manifest.documents.length,
    formats: 4,
    languages: ['FR', 'EN'],
    offsetUnit: policy.offsetUnit,
    hashEncoding: 'UTF8',
    popplerVersion,
    parserSourceHashes,
    nativeProviderCalls: 0,
    databaseCalls: 0,
    httpCalls: 0,
    semanticFinalGeometry: 'NOT_RUN',
});
console.log(
    JSON.stringify({
        status: 'CANONICAL_CONFIRMED_NOT_INDEXED',
        documents: 24,
        queries: queries.length,
        corpusDigest,
        nativeProviderCalls: 0,
    })
);
