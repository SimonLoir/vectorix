/** Frozen artificial files and optional local regeneration only; no runtime/service/database work. */
import assert from 'node:assert/strict';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256, validateFixtures } from './evaluate.mjs';
import { loadFixtures, boundedJson } from './fixture-loader.mjs';
import { workspaceRoot } from './workspace-root.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const frozenDirectory = path.join(directory, 'reference-v1');
const args = process.argv.slice(2);
assert(
    args.length === 0 || (args.length === 2 && args[0] === '--generated'),
    'Use no arguments, or --generated ABSOLUTE_PRIVATE_REGENERATION_DIRECTORY'
);
const provenance = await boundedJson(
    path.join(directory, 'helper-provenance.json')
);
const hashes = provenance.corpusFilesSha256;
assert(Object.keys(hashes).length === 56, 'FROZEN_FILE_INVENTORY');
const fixtures = await loadFixtures();
validateFixtures(fixtures);
assert.equal(
    fixtures.manifest.corpusDigest,
    'cb372b53964ffe896bb4e3c3c44831db6c0949bbe622e63ce0a482607be6fdbc'
);
for (const [relative, expected] of Object.entries(hashes)) {
    assert(
        /^(?:(?:originals|canonical)\/m7c-[fd]\d{2}-(?:en|fr)-v1\.(?:json|txt|md|pdf|docx)|[a-z-]+\.json)$/u.test(
            relative
        ),
        'FROZEN_RELATIVE_FILE'
    );
    assert.equal(
        sha256(await readFile(path.join(frozenDirectory, relative))),
        expected,
        'FROZEN_BYTES_CHANGED'
    );
}
let regeneratedFiles = 0;
if (args.length) {
    const generated = args[1];
    const cache = path.join(workspaceRoot(), 'node_modules/.cache/vectorix');
    const info = await lstat(generated);
    assert(
        path.isAbsolute(generated) &&
            (await realpath(generated)) === generated &&
            generated.startsWith(cache + path.sep) &&
            info.isDirectory() &&
            info.uid === process.getuid() &&
            (info.mode & 0o777) === 0o700,
        'PRIVATE_REGENERATION_DIRECTORY_REQUIRED'
    );
    for (const [relative, expected] of Object.entries(hashes)) {
        if (relative === 'canonical-proof.json') continue;
        assert.equal(
            sha256(await readFile(path.join(generated, relative))),
            expected,
            'REGENERATION_CHANGED_FROZEN_BYTES'
        );
        regeneratedFiles++;
    }
    const expectedProof = await boundedJson(
        path.join(frozenDirectory, 'canonical-proof.json')
    );
    const actualProof = await boundedJson(
        path.join(generated, 'canonical-proof.json')
    );
    assert(
        /^[a-f0-9]{40}$/u.test(actualProof.sourceCommit),
        'REGENERATION_PRODUCT_COMMIT'
    );
    delete expectedProof.sourceCommit;
    delete actualProof.sourceCommit;
    assert.deepEqual(
        actualProof,
        expectedProof,
        'REGENERATION_PARSER_OR_CANONICAL_PROOF_CHANGED'
    );
}
console.log(
    JSON.stringify({
        status: args.length
            ? 'REGENERATION_MATCHES_FROZEN_REFERENCE'
            : 'FROZEN_FIXTURES_VALID',
        corpusDigest: fixtures.manifest.corpusDigest,
        frozenFiles: 56,
        regeneratedByteIdenticalFiles: regeneratedFiles,
        historicalParserProof: args.length
            ? 'MATCHES_EXCEPT_CURRENT_GIT_COMMIT'
            : 'BYTE_IDENTICAL',
        nativeQualityAcceptance: 'NOT_RUN',
        capacityAcceptance: 'NOT_RUN',
        providerCalls: 0,
        databaseCalls: 0,
        httpCalls: 0,
    })
);
