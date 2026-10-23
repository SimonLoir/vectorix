/** Offline frozen-file and relocation inventory verification only. No clients, services or native calls. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { getLoadPolicy, policySha256 } from './load-policy-registry.mjs';
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
    provenance.schemaVersion === 2 &&
        Object.keys(provenance.postTimingPreRelocationRuntimeSha256).length ===
            44 &&
        provenance.previousDeliveredDefault.commit ===
            '810fe339724254dee66896bc276a8415a3785915' &&
        Object.keys(provenance.previousDeliveredDefault.sourcesSha256)
            .length === 60 &&
        Object.keys(provenance.previousDeliveredDefault.runtimeSha256)
            .length === 44 &&
        Object.keys(provenance.currentSourcesSha256).length >= 60 &&
        Object.keys(provenance.currentSourcesSha256).length <= 90 &&
        Object.keys(provenance.loadFilesSha256).length === 3 &&
        Object.keys(provenance.lightFilesSha256).length === 3 &&
        Object.keys(provenance.canonicalReferenceFilesSha256).length === 53
);
// A newly added runtime/test module cannot silently escape the frozen inventory.
const actualSources = fs
    .readdirSync(here)
    .filter(
        (name) =>
            /\.(?:mjs|py)$/u.test(name) && name !== 'validate-preparation.mjs'
    )
    .sort();
need(
    JSON.stringify(actualSources) ===
        JSON.stringify(Object.keys(provenance.currentSourcesSha256).sort())
);
need(
    Object.keys(provenance.closedExperiments).sort().join(',') ===
        'DEFAULT_V1,LIGHT_V1'
);
for (const name of ['DEFAULT_V1', 'LIGHT_V1']) {
    const policy = getLoadPolicy(name),
        expected = provenance.closedExperiments[name];
    need(
        expected.policySha256 === policySha256(policy) &&
            expected.namespace === policy.namespace &&
            expected.version === policy.policyVersion &&
            expected.family === policy.identity.family &&
            expected.pilot === policy.identity.pilot &&
            expected.full === policy.identity.full
    );
}
need(
    !fs.existsSync(path.join(here, 'reference-v1')) &&
        !fs.existsSync(path.join(here, 'supplemental-b53.mjs'))
);
verify(here, provenance.currentSourcesSha256);
verify(path.join(here, 'load-v1'), provenance.loadFilesSha256);
verify(path.join(here, 'light-v1'), provenance.lightFilesSha256);
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
        relocatedSourceFiles: actualSources.length,
        loadMetadataFiles: 3,
        lightMetadataFiles: 3,
        closedExperiments: ['DEFAULT_V1', 'LIGHT_V1'],
        canonicalReferenceFiles: 53,
        nativeOrResourceActions: 0,
        nativeAcceptance: 'NOT_ASSESSED_BY_VALIDATOR',
    })
);
