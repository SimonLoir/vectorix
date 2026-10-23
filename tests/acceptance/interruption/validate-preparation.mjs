/** Offline source/fixture consistency only. No clients, subprocesses, topology state or native calls. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (value) => {
    if (!value) throw new Error('INTERRUPTION_FROZEN_INPUT_MISMATCH');
};
function read(relative, maximum = 2 * 1024 ** 2) {
    need(
        typeof relative === 'string' &&
            /^[A-Za-z0-9_./-]{1,180}$/u.test(relative) &&
            !relative.split('/').includes('..')
    );
    const filename = path.join(here, relative);
    need(fs.realpathSync(path.dirname(filename)) === path.dirname(filename));
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const info = fs.fstatSync(descriptor);
        need(info.isFile() && info.size <= maximum);
        const buffer = Buffer.alloc(maximum + 1);
        let used = 0;
        while (used < buffer.length) {
            const count = fs.readSync(
                descriptor,
                buffer,
                used,
                buffer.length - used,
                null
            );
            if (!count) break;
            used += count;
        }
        need(used <= maximum);
        return buffer.subarray(0, used);
    } finally {
        fs.closeSync(descriptor);
    }
}
const proof = JSON.parse(read('helper-provenance.json', 128 * 1024));
need(
    proof.schemaVersion === 1 &&
        proof.relocatedNativeRetest === 'NOT_RUN' &&
        proof.actualRun.runId === '8af698331852' &&
        proof.actualRun.formalObserverStatus ===
            'INCOMPLETE_OBSERVER_TIMESTAMP' &&
        Object.keys(proof.actualRun.actualSourcesSha256).length === 17 &&
        Object.keys(proof.timestampShadow.sourcesSha256).length === 3 &&
        proof.timestampShadow.validation.tests === 20 &&
        proof.timestampShadow.validation.resourceCalls === 0
);
const sources = proof.relocatedSourcesSha256;
need(
    Object.keys(sources).length >= 16 &&
        Object.keys(sources).length <= 32 &&
        !Object.hasOwn(sources, 'helper-provenance.json')
);
for (const [name, expected] of Object.entries(sources))
    need(/^[a-f0-9]{64}$/u.test(expected) && hash(read(name)) === expected);
const runtimeNames = [
    'fault/fault_admission.py',
    'fault/fault_driver.py',
    'fixture/fixture.mjs',
    'fixture/preflight.mjs',
    'observer/recovery_observation.py',
    'observer/recovery_observer.py',
];
need(
    Object.keys(proof.runtimeSourcesSha256).sort().join(',') ===
        runtimeNames.sort().join(',') &&
        runtimeNames.every(
            (name) => proof.runtimeSourcesSha256[name] === sources[name]
        ) &&
        Object.values(proof.actualRun.actualSourcesSha256).every((value) =>
            /^[a-f0-9]{64}$/u.test(value)
        ) &&
        Object.values(proof.timestampShadow.sourcesSha256).every((value) =>
            /^[a-f0-9]{64}$/u.test(value)
        )
);
const observer = JSON.parse(read('observer/observer-manifest.json', 16384));
need(
    hash(read('observer/observer-manifest.json')) ===
        proof.observerManifestSha256 &&
        observer.schemaVersion === 1 &&
        observer.status === 'FROZEN_OFFLINE_NATIVE_NOT_RUN' &&
        Object.keys(observer.runtimeSha256).sort().join(',') ===
            'recovery_observation.py,recovery_observer.py' &&
        Object.keys(observer.faultSha256).sort().join(',') ===
            'fault_admission.py,fault_driver.py'
);
for (const [name, expected] of Object.entries(observer.runtimeSha256))
    need(hash(read('observer/' + name)) === expected);
for (const [name, expected] of Object.entries(observer.faultSha256))
    need(hash(read('fault/' + name)) === expected);
const frozen = proof.fixture;
for (const name of ['original', 'canonical'])
    need(hash(read(frozen[name].path)) === frozen[name].actualSha256);
need(
    hash(read(frozen.relocatedPreflight.path)) ===
        frozen.relocatedPreflight.sha256 &&
        frozen.original.actualSha256 === frozen.originalSha256 &&
        frozen.canonical.actualSha256 === frozen.canonicalSha256
);
console.log(
    JSON.stringify({
        status: 'PASS',
        relocatedSourceFiles: Object.keys(sources).length,
        actualArchivedFiles: 17,
        originalAndCanonicalFrozen: true,
        nativeOrResourceActions: 0,
        formalHistoricalObserver: 'INCOMPLETE_OBSERVER_TIMESTAMP',
        relocatedNativeRetest: 'NOT_RUN',
    })
);
