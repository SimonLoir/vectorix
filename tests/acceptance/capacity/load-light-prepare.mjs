/** Offline deterministic metadata only. No native runtime, service, catalog or network adapter exists. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { preflight } from './load-light-corpus.mjs';
import {
    POLICY_VERSION,
    NAMESPACE,
    LIVE_IO_DISABLED,
    FINITE_GATES,
    RESOURCE_LIMITS,
    MODEL_REQUIREMENT,
    profileForRole,
} from './load-light-policy.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url)),
    ROOT = path.resolve(HERE, '../../..');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const need = (value) => {
    if (!value) throw Error('LIGHT_PREPARATION_REFUSED');
};
const encode = (value) => Buffer.from(JSON.stringify(value, null, 4) + '\n');
function boundedRead(
    filename,
    maximum,
    privateFile = false,
    publicMetadata = false
) {
    need(fs.realpathSync(path.dirname(filename)) === path.dirname(filename));
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const stat = fs.fstatSync(descriptor);
        need(
            stat.isFile() &&
                stat.uid === process.getuid() &&
                stat.size <= maximum &&
                (!privateFile || (stat.mode & 0o777) === 0o600) &&
                (!publicMetadata || [0o600, 0o644].includes(stat.mode & 0o777))
        );
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
function writeExclusive(filename, bytes) {
    const descriptor = fs.openSync(
        filename,
        fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
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
/** Reconstruct both scales from the same source family before freezing any new input hash. */
export function prepareMetadata() {
    const full = preflight({ documentCount: 200 }),
        pilot = preflight({ documentCount: 4 });
    need(
        JSON.stringify(pilot.documents) ===
            JSON.stringify(full.documents.slice(0, 4)) &&
            pilot.familySha256 === full.familySha256
    );
    const production = [
        ...fs
            .readdirSync(path.join(ROOT, 'packages/chunking/src'))
            .filter((name) => name.endsWith('.ts'))
            .sort()
            .map((name) => 'packages/chunking/src/' + name),
        'packages/documents/src/index.ts',
        'packages/embeddings/src/preparation.ts',
    ];
    need(production.length <= 48);
    const originalProvenance = boundedRead(
        path.join(ROOT, 'tests/acceptance/quality/helper-provenance.json'),
        256 * 1024
    );
    const referenceProvenance = Object.fromEntries(
        Object.entries(JSON.parse(originalProvenance).corpusFilesSha256)
            .filter(
                ([name]) =>
                    ![
                        'canonical-proof.json',
                        'geometry-preflight.json',
                        'source-manifest.json',
                    ].includes(name)
            )
            .map(([name, digest]) => ['reference-v1/' + name, digest])
    );
    need(Object.keys(referenceProvenance).length === 53);
    const referenceHashes = Object.fromEntries(
        Object.keys(referenceProvenance).map((name) => {
            const actual = sha(
                boundedRead(
                    path.join(ROOT, 'tests/acceptance/quality', name),
                    2 * 1024 ** 2
                )
            );
            need(actual === referenceProvenance[name]);
            return [name, actual];
        })
    );
    const outputs = {
        'pilot-preflight.json': encode(pilot),
        'full-preflight.json': encode(full),
    };
    const proof = {
        schemaVersion: 1,
        status: 'OFFLINE_LIGHT_PREPARATION_NATIVE_NOT_RUN',
        namespace: NAMESPACE,
        policyVersion: POLICY_VERSION,
        runtimeImplemented: false,
        liveIoDisabled: LIVE_IO_DISABLED,
        nativeAcceptance: 'NOT_RUN',
        capacityAcceptance: 'NOT_RUN',
        trafficAcceptance: 'NOT_RUN',
        familySha256: full.familySha256,
        pilotCorpusSha256: pilot.corpusSha256,
        fullCorpusSha256: full.corpusSha256,
        pilotChildren: pilot.totals.children,
        pilotParents: pilot.totals.parents,
        fullChildren: full.totals.children,
        fullParents: full.totals.parents,
        sourceBytes: full.totals.sourceBytes,
        preparedInputBytes: full.totals.preparedInputBytes,
        estimatedNativeInputTokens: full.totals.estimatedInputTokens,
        distinctFullChildTexts: full.distinctChildTexts,
        distinctFullPreparedInputs: full.distinctPreparedInputs,
        pilotExactFullPrefix: true,
        model: MODEL_REQUIREMENT,
        resourceLimits: RESOURCE_LIMITS,
        finiteGates: FINITE_GATES,
        profileRoles: Object.fromEntries(
            [
                'pilotA',
                'primaryA',
                'referenceB',
                'ingestionA',
                'ingestionB',
            ].map((role) => [role, profileForRole(role)])
        ),
        frozenMetadataSha256: Object.fromEntries(
            Object.entries(outputs).map(([name, bytes]) => [name, sha(bytes)])
        ),
        preparationSourcesSha256: Object.fromEntries(
            [
                'load-light-policy.mjs',
                'load-light-corpus.mjs',
                'load-light-prepare.mjs',
            ].map((name) => [
                name,
                sha(boundedRead(path.join(HERE, name), 256 * 1024)),
            ])
        ),
        productionSourcesSha256: Object.fromEntries(
            production.map((name) => [
                name,
                sha(boundedRead(path.join(ROOT, name), 512 * 1024)),
            ])
        ),
        canonicalQualityProvenanceSha256: sha(originalProvenance),
        unchangedCanonicalReferenceSha256: referenceHashes,
        measuredNativeContext: null,
        nativeProbe: 'NOT_RUN_REQUIRED_BEFORE_COST',
        nativeTiming: 'UNMEASURED',
        sourceFilesEmitted: 0,
        providerCalls: 0,
        databaseCalls: 0,
        httpCalls: 0,
        originalExperiment: 'IMMUTABLE_SEPARATE_MEASUREMENT',
    };
    outputs['preparation-proof.json'] = encode(proof);
    return { outputs, proof };
}
/** Generate once into private staging, or check existing exact bytes; never overwrite a preparation. */
export function main(args = process.argv.slice(2)) {
    need(args.length === 1 && ['generate', 'check'].includes(args[0]));
    const { outputs, proof } = prepareMetadata(),
        directory = path.join(HERE, 'light-v1');
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
    } else {
        const stat = fs.lstatSync(directory);
        need(
            stat.isDirectory() &&
                !stat.isSymbolicLink() &&
                stat.uid === process.getuid() &&
                [0o700, 0o755].includes(stat.mode & 0o777) &&
                fs.realpathSync(directory) === directory
        );
        need(
            JSON.stringify(fs.readdirSync(directory).sort()) ===
                JSON.stringify(Object.keys(outputs).sort())
        );
        for (const [name, bytes] of Object.entries(outputs))
            need(
                boundedRead(
                    path.join(directory, name),
                    2 * 1024 ** 2,
                    false,
                    true
                ).equals(bytes)
            );
    }
    return {
        status: 'OFFLINE_LIGHT_PREPARATION_VALID',
        policyVersion: POLICY_VERSION,
        familySha256: proof.familySha256,
        pilotCorpusSha256: proof.pilotCorpusSha256,
        fullCorpusSha256: proof.fullCorpusSha256,
        fullChildren: proof.fullChildren,
        fullParents: proof.fullParents,
        sourceBytes: proof.sourceBytes,
        preparedInputBytes: proof.preparedInputBytes,
        estimatedNativeInputTokens: proof.estimatedNativeInputTokens,
        proofSha256: sha(outputs['preparation-proof.json']),
        capacityAcceptance: 'NOT_RUN',
        nativeCalls: 0,
        runtimeImplemented: false,
    };
}
if (
    process.argv[1] &&
    pathToFileURL(process.argv[1]).href === import.meta.url
) {
    try {
        console.log(JSON.stringify(main()));
    } catch {
        console.error(
            JSON.stringify({
                status: 'REFUSED',
                diagnostic: 'LIGHT_PREPARATION_REFUSED',
                nativeAcceptance: 'NOT_RUN',
            })
        );
        process.exitCode = 1;
    }
}
