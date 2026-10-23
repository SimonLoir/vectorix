/** Frozen local artificial content only. Importing opens no files, loaders, clients or services. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
    sha,
    validateManifest,
    validateReferences,
    LOAD_LIMITS,
} from './load-import-core.mjs';

const requireValue = (value) => {
    if (!value) throw new Error('LOAD_RUNTIME_CONTENT');
};
/** Copy only bounded pinned files; never resolve arbitrary descriptor paths or follow a leaf symlink. */
export function readPinnedLoadFile(
    directory,
    state,
    relative,
    maximum = 2 * 1024 ** 2
) {
    requireValue(
        Number.isSafeInteger(maximum) &&
            maximum >= 0 &&
            maximum <= 2 * 1024 ** 2
    );
    requireValue(
        typeof relative === 'string' &&
            /^(?:reference-v1\/(?:[a-z-]+\.json|(?:originals|canonical)\/m7c-[fd]\d{2}-(?:en|fr)-v1\.(?:json|txt|md|pdf|docx))|load-v1\/[a-z-]+\.json)$/u.test(
                relative
            )
    );
    // Reference data has one canonical tracked location; logical manifest keys remain unchanged.
    const base = relative.startsWith('reference-v1/')
        ? path.resolve(directory, '../quality')
        : directory;
    const filename = path.join(base, relative);
    requireValue(
        fs.realpathSync(path.dirname(filename)) === path.dirname(filename)
    );
    const fd = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    let bytes;
    try {
        const stat = fs.fstatSync(fd);
        requireValue(stat.isFile() && stat.size <= maximum);
        const buffer = Buffer.alloc(maximum + 1);
        let used = 0;
        while (used < buffer.length) {
            const count = fs.readSync(
                fd,
                buffer,
                used,
                buffer.length - used,
                null
            );
            if (count === 0) break;
            used += count;
        }
        requireValue(used <= maximum);
        bytes = buffer.subarray(0, used);
        requireValue(sha(bytes) === state.corpusFiles?.[relative]);
    } finally {
        fs.closeSync(fd);
    }
    return bytes;
}
const json = (bytes) =>
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
/** The runtime injects already guarded local generators/decoders; source hashes still bind every generated original. */
export function createFrozenLoadContent({
    manifest,
    references,
    readReferenceOriginal,
    buildGenerated,
    decodeText,
}) {
    validateManifest(manifest);
    validateReferences(references);
    requireValue(
        [readReferenceOriginal, buildGenerated, decodeText].every(
            (fn) => typeof fn === 'function'
        )
    );
    const generated = new Map(manifest.documents.map((doc) => [doc.id, doc]));
    const reference = new Map(
        references.manifest.documents.map((doc) => [doc.fixtureId, doc])
    );
    const original = async (descriptor) => {
        const spec = generated.get(descriptor.fixtureId);
        let bytes;
        if (spec) {
            requireValue(
                descriptor.fileName === spec.filename &&
                    descriptor.originalSha256 === spec.sourceSha256
            );
            bytes = Buffer.from(await buildGenerated(spec));
        } else {
            const source = reference.get(descriptor.fixtureId);
            requireValue(
                source &&
                    descriptor.fileName === source.fileName &&
                    descriptor.originalSha256 === source.originalSha256
            );
            bytes = await readReferenceOriginal(source);
        }
        requireValue(
            bytes instanceof Uint8Array &&
                bytes.length > 0 &&
                bytes.length <= LOAD_LIMITS.sourceBytes &&
                bytes.length === descriptor.originalBytes &&
                sha(bytes) === descriptor.originalSha256
        );
        return new Uint8Array(bytes);
    };
    return {
        manifest,
        references,
        readOriginal: original,
        async readCanonical(descriptor) {
            const source = reference.get(descriptor.fixtureId);
            if (source)
                return structuredClone(references.artifacts[source.fixtureId]);
            const artifact = decodeText(await original(descriptor));
            requireValue(
                artifact?.text?.length === descriptor.canonicalLength &&
                    sha(artifact.text) === descriptor.canonicalSha256 &&
                    artifact.format === 'TEXT'
            );
            return artifact;
        },
    };
}
/** Local reads/TypeScript imports occur only after independent ownership and frozen-source admission. */
export async function loadRuntimeContent({
    root,
    helperDirectory,
    state,
    admit,
}) {
    requireValue(typeof admit === 'function');
    await admit();
    const read = (relative) =>
        readPinnedLoadFile(helperDirectory, state, relative);
    const manifest = validateManifest(
        json(read('load-v1/full-preflight.json'))
    );
    const referenceManifest = json(read('reference-v1/manifest.json'));
    const artifacts = {};
    for (const doc of referenceManifest.documents ?? []) {
        requireValue(typeof doc.canonicalPath === 'string');
        artifacts[doc.fixtureId] = json(
            read('reference-v1/' + doc.canonicalPath)
        );
    }
    const references = validateReferences({
        manifest: referenceManifest,
        artifacts,
    });
    await admit();
    const require = createRequire(path.join(root, 'apps/api/package.json'));
    const { tsImport } = await import(
        pathToFileURL(require.resolve('tsx/esm/api')).href
    );
    const generator = await tsImport(
        pathToFileURL(path.join(helperDirectory, 'load-corpus.mjs')).href,
        import.meta.url
    );
    const documents = await tsImport(
        pathToFileURL(path.join(root, 'packages/documents/src/index.ts')).href,
        import.meta.url
    );
    await admit();
    return createFrozenLoadContent({
        manifest,
        references,
        readReferenceOriginal: async (doc) =>
            read('reference-v1/' + doc.originalPath),
        buildGenerated: async (spec) =>
            generator.buildDocument(generator.documentSpec(spec.index)),
        decodeText: (bytes) =>
            documents.decodeStoredExtraction(
                Buffer.from(bytes),
                'utf8-text-v1'
            ),
    });
}
