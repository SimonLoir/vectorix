/** Offline frozen-file and relocation inventory verification only. No clients, services or native calls. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (value) => {
    if (!value) throw Error('CAPACITY_FROZEN_INPUT_MISMATCH');
};
const provenance = JSON.parse(
    fs.readFileSync(path.join(here, 'helper-provenance.json'), 'utf8')
);
function verify(directory, entries) {
    for (const [name, expected] of Object.entries(entries)) {
        need(
            !name.split('/').includes('..') && /^[a-f0-9]{64}$/u.test(expected)
        );
        const filename = path.join(directory, name),
            info = fs.lstatSync(filename);
        need(
            info.isFile() &&
                !info.isSymbolicLink() &&
                info.size <= 2 * 1024 ** 2 &&
                fs.realpathSync(filename) === filename &&
                hash(fs.readFileSync(filename)) === expected
        );
    }
}
need(
    provenance.nativeArchivedRuns.length === 2 &&
        provenance.nativeArchivedRuns.every(
            (run) =>
                run.formalPilotStatus === 'INCOMPLETE' &&
                Object.keys(run.actualArchivedHelpersSha256).length === 44
        )
);
need(
    Object.keys(provenance.postTimingPreRelocationRuntimeSha256).length ===
        44 &&
        Object.keys(provenance.relocatedSourcesSha256).length === 60 &&
        Object.keys(provenance.loadFilesSha256).length === 3 &&
        Object.keys(provenance.canonicalReferenceFilesSha256).length === 53
);
need(
    !fs.existsSync(path.join(here, 'reference-v1')) &&
        !fs.existsSync(path.join(here, 'supplemental-b53.mjs'))
);
verify(here, provenance.relocatedSourcesSha256);
verify(path.join(here, 'load-v1'), provenance.loadFilesSha256);
verify(path.join(here, '../quality'), provenance.canonicalReferenceFilesSha256);
need(
    hash(
        fs.readFileSync(
            path.join(root, 'tests/acceptance/restore/m7c_restore_common.py')
        )
    ) === provenance.sharedRestoreDependencySha256
);
console.log(
    JSON.stringify({
        status: 'PASS',
        relocatedSourceFiles: 60,
        loadMetadataFiles: 3,
        canonicalReferenceFiles: 53,
        nativeOrResourceActions: 0,
        relocatedNativeRetest: 'NOT_RUN',
    })
);
