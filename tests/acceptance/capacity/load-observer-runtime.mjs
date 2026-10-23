/** Guarded real read-only adapters. Importing performs no filesystem/SDK/process/network operation. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {
    need,
    digest,
    validateIdentity,
    OBSERVER_LIMITS,
    LoadObservationError,
} from './load-observer-core.mjs';
import { createLoadObserver } from './load-observer.mjs';
import {
    readNativeSnapshot,
    readGenerationProof,
    readProgressSnapshot,
} from './load-observer-sql.mjs';
import {
    readPrivate,
    privateDirectory,
    privateCheckpoint,
} from './load-private.mjs';
import { observationPolicy } from './load-observer-core.mjs';
import { observationProfile } from './load-observer-policy.mjs';
import { sourceFormat } from './load-observer-layout.mjs';
export const STATIC_DRAFT_ONLY = false;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
/** The independently reviewed load guard checks exact labels, IDs, images, mounts, ports, schema and caller PID. */
export function loadObserverGuard({ state, statePath }) {
    const policy = observationPolicy(state);
    const expected = path.join(
        ROOT,
        'node_modules/.cache/vectorix',
        state.prefix,
        'state.json'
    );
    need(
        statePath === expected &&
            state.prefix === policy.namespace + '-' + state.runId,
        'LOAD_OBS_GUARD'
    );
    const child = spawnSync(
        'python3',
        [
            '-B',
            path.join(HERE, 'load-topology.py'),
            '--experiment',
            policy.id,
            '--run',
            state.runId,
            '--mode',
            'guard',
            '--purpose',
            'import',
        ],
        {
            cwd: ROOT,
            env: Object.fromEntries(
                ['PATH', 'LANG', 'LC_ALL', 'TMPDIR']
                    .filter((key) => process.env[key] !== undefined)
                    .map((key) => [key, process.env[key]])
            ),
            encoding: 'utf8',
            timeout: 30000,
            maxBuffer: 16384,
        }
    );
    need(child.status === 0 && !child.error, 'LOAD_OBS_GUARD');
    let value;
    try {
        value = JSON.parse(child.stdout);
    } catch {
        throw new LoadObservationError('LOAD_OBS_GUARD');
    }
    need(
        value.schemaVersion === 1 &&
            value.experimentPolicyId === policy.id &&
            value.experimentPolicySha256 === state.experimentPolicySha256 &&
            value.namespace === state.namespace &&
            value.runId === state.runId &&
            value.purpose === 'import' &&
            value.resourceOwnership === true &&
            value.databaseReadOnly === true &&
            value.bootstrapFreshness === false,
        'LOAD_OBS_GUARD'
    );
    return value;
}
/** Read the fixed worker tuple already admitted by the guard; never serialize environment/command lines. */
export function producerIdentity(state) {
    const worker = state.processes?.workers;
    need(
        worker?.service === 'workers' &&
            Number.isSafeInteger(worker.pid) &&
            worker.pid > 1 &&
            typeof worker.startTicks === 'string',
        'LOAD_OBS_PRODUCER'
    );
    let stat;
    try {
        stat = fs.readFileSync('/proc/' + worker.pid + '/stat', 'utf8');
    } catch {
        throw new LoadObservationError('LOAD_OBS_PRODUCER');
    }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    need(
        !['Z', 'X'].includes(fields[0]) && fields[19] === worker.startTicks,
        'LOAD_OBS_PRODUCER'
    );
    return digest({
        runId: state.runId,
        commit: state.commit,
        worker: {
            pid: worker.pid,
            startTicks: worker.startTicks,
            bootId: worker.bootId,
            entrySha256: worker.entrySha256,
        },
        resourceIds: Object.fromEntries(
            Object.entries(state.resources).map(([service, value]) => [
                service,
                value.containerId ?? value.id,
            ])
        ),
    });
}
/** Strict immutable files. Only opaque hashed names under one separately owned700 directory are accepted. */
export function nativeReceiptStore(directory) {
    privateDirectory(directory);
    const filename = (name) => {
        need(
            /^(baseline|receipt)-[a-f0-9]{64}\.json$/u.test(name),
            'LOAD_OBS_RECEIPT'
        );
        return path.join(directory, name);
    };
    return {
        write: async (name, value) =>
            privateCheckpoint(filename(name), value, true),
        read: async (name) => {
            try {
                return JSON.parse(
                    readPrivate(filename(name), 32768).toString('utf8')
                );
            } catch {
                throw new LoadObservationError('LOAD_OBS_RECEIPT');
            }
        },
    };
}
/** Import-only seam uses the installed loader explicitly; a plain Node .mjs entry needs no ambient --import flag. */
export async function loadObservationPackages(admit) {
    need(typeof admit === 'function', 'LOAD_OBS_GUARD');
    await admit();
    const require = createRequire(path.join(ROOT, 'apps/api/package.json'));
    const resolveWorkspace = createRequire(
        path.join(ROOT, 'packages/routers/rag/package.json')
    );
    const { tsImport } = await import(
        pathToFileURL(require.resolve('tsx/esm/api')).href
    );
    const [chunking, documents, embeddings, vector] = await Promise.all(
        [
            '@repo/chunking',
            '@repo/documents',
            '@repo/embeddings',
            '@repo/vector-store',
        ].map((name) =>
            tsImport(
                pathToFileURL(resolveWorkspace.resolve(name)).href,
                import.meta.url
            )
        )
    );
    return {
        Client: require('pg').Client,
        chunking,
        documents,
        embeddings,
        vector,
    };
}
/** No environment defaults, provisioning connection, DDL, S3 or provider operation exists in this observer. */
export async function createLoadObservationRuntime({
    state,
    fixture,
    statePath,
    receiptDirectory,
    readCanonical,
    referenceMetadataFields,
}) {
    need(!STATIC_DRAFT_ONLY, 'LOAD_OBS_RUNTIME_DISABLED');
    validateIdentity(state, fixture);
    const admit = async () => loadObserverGuard({ state, statePath });
    await admit(); // Must precede SDK imports and every connection construction.
    const { Client, chunking, documents, embeddings, vector } =
        await loadObservationPackages(admit);
    need(typeof readCanonical === 'function', 'LOAD_OBS_CANONICAL_ADAPTER');
    const dependencies = {
        profile: (input) =>
            observationProfile(state, fixture, input, referenceMetadataFields),
        canonical: async (descriptor, extractorVersion) => {
            const expected = sourceFormat(descriptor);
            need(
                extractorVersion === expected.extractorVersion,
                'LOAD_OBS_SOURCE'
            );
            const artifact = documents.structuredExtraction.parse(
                await readCanonical(descriptor)
            );
            need(
                Buffer.byteLength(artifact.text) <=
                    OBSERVER_LIMITS.sourceBytes &&
                    artifact.format === expected.format,
                'LOAD_OBS_SOURCE_BOUND'
            );
            return artifact;
        },
        plan: (artifact, profile, identity, title) => {
            const child = [
                ...chunking
                    .resolveChunkingStrategy(
                        profile.chunkingStrategy,
                        'token-window-utf8-v1'
                    )
                    .plan(artifact, {
                        ...profile.chunking,
                        maxEmbeddingInputBytes:
                            embeddings.embeddingInputByteLimit(identity, {
                                kind: 'document',
                                title,
                                preparation: '',
                            }),
                        maxChunks: 500,
                    }),
            ];
            const parent = chunking.planParentContext(artifact, child, {
                parentMaxTokens: profile.chunking.parentMaxTokens,
            });
            return {
                children: child,
                parents: parent.parents,
                mapping: parent.childParentOrdinals,
            };
        },
        identity: (value) => embeddings.modelIdentity.parse(value),
        prepare: embeddings.prepareEmbeddingInput,
        manifestHash: vector.manifestHash,
        generationTable: vector.generationTable,
    };
    async function connection(key, callback) {
        await admit();
        const client = new Client({
            connectionString: state.environment[key],
            connectionTimeoutMillis: 5000,
            query_timeout: 12000,
        });
        try {
            await client.connect();
            return await callback(client);
        } catch (error) {
            if (error instanceof LoadObservationError) throw error;
            throw new LoadObservationError('LOAD_OBS_DATABASE_READ');
        } finally {
            await client.end().catch(() => {});
        }
    }
    const reader = {
        native: (input) =>
            connection('DATABASE_URL', (client) =>
                readNativeSnapshot(client, {
                    state,
                    input,
                    producerIdentitySha256: producerIdentity(state),
                })
            ),
        generation: (input) =>
            connection('DATABASE_URL', (app) =>
                connection('VECTOR_DATABASE_URL', (vx) =>
                    readGenerationProof(app, vx, { state, input, dependencies })
                )
            ),
    };
    return {
        ...createLoadObserver({
            state,
            fixture,
            admit,
            reader,
            store: nativeReceiptStore(receiptDirectory),
            now: () => Math.floor(performance.now()),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        }),
        readProgress: (input) =>
            connection('DATABASE_URL', (client) =>
                readProgressSnapshot(client, { state, fixture, input })
            ),
    };
}
