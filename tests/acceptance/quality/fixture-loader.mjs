import assert from 'node:assert/strict';
import { readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BASE = fileURLToPath(new URL('./reference-v1/', import.meta.url));

export async function boundedJson(file, maxBytes = 8 * 1024 * 1024) {
    const info = await lstat(file);
    assert(
        info.isFile() && !info.isSymbolicLink() && info.size <= maxBytes,
        'UNSAFE_OR_OVERSIZED_JSON'
    );
    const bytes = await readFile(file);
    assert(bytes.length <= maxBytes, 'JSON_BYTE_LIMIT');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** Only generated canonical files inside this fixture root can be loaded. */
export async function loadFixtures(base = BASE) {
    const root = await realpath(base);
    const [manifest, queries, qrels, policy, development] = await Promise.all(
        [
            'manifest.json',
            'queries.json',
            'qrels.json',
            'policy.json',
            'development-queries.json',
        ].map((name) => boundedJson(path.join(root, name)))
    );
    const artifacts = {};
    assert(manifest.documents.length === 24);
    for (const document of manifest.documents) {
        assert(
            /^canonical\/m7c-[fd]\d{2}-(?:en|fr)-v1\.json$/u.test(
                document.canonicalPath
            ),
            'INVALID_CANONICAL_PATH'
        );
        const file = await realpath(path.join(root, document.canonicalPath));
        assert(
            file.startsWith(`${root}${path.sep}`),
            'CANONICAL_OUTSIDE_FIXTURE_ROOT'
        );
        artifacts[document.fixtureId] = await boundedJson(file, 256 * 1024);
    }
    return { manifest, queries, qrels, policy, artifacts, development };
}
