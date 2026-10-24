/** Bounded read-only G1/G2 observer. Physical reads are prohibited while vector PostgreSQL is stopped. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    context,
    ROOT,
    need,
    privateJson,
    privateBytes,
    writePrivate,
    receiptScope,
    sameScope,
    openFixturePrisma,
    entryError,
} from './private.mjs';
import { finalizeCleanupObservation } from './cleanup-observe.mjs';
import { watchdogTraceDeadline, waitForNextSnapshot } from './observe.mjs';
import { PROFILE, syntheticVector } from './vector-embedding.mjs';
import {
    sha,
    id,
    parseVectorArgs,
    readVectorOriginal,
} from './vector-workflow.mjs';
export const STATIC_DRAFT_ONLY = true;
import {
    VECTOR_PHASES,
    assessVectorSnapshot,
    assertVectorContinuity,
    validateVectorTrace,
    failure,
    canonical,
} from './vector-observation.mjs';
import {
    readVectorAppSnapshot,
    vectorPool,
    readPhysicalVector,
} from './vector-snapshot.mjs';
async function preparedLayout(state, original) {
    const requireApi = createRequire(path.join(ROOT, 'apps/api/package.json')),
        entry = requireApi.resolve('tsx/esm/api');
    failure(
        Object.values(state.inputs.runtime).some(
            (item) =>
                item.name === 'tsx' &&
                fs.realpathSync(entry).startsWith(item.root + path.sep)
        ),
        'PLANNER_RUNTIME'
    );
    const { tsImport } = await import(pathToFileURL(entry).href);
    const { chunkDocumentStructure, planParentContext } = await tsImport(
        pathToFileURL(path.join(ROOT, 'packages/chunking/src/index.ts')).href,
        { parentURL: import.meta.url, tsconfig: false }
    );
    const text = original.toString('utf8'),
        artifact = {
            schemaVersion: 1,
            format: 'TEXT',
            text,
            sources: [{ kind: 'text', index: 0, start: 0, end: text.length }],
            warnings: [],
        };
    const children = [
        ...chunkDocumentStructure(artifact, {
            ...PROFILE.chunking,
            maxEmbeddingInputBytes: 2016,
        }),
    ];
    const layout = planParentContext(artifact, children, {
        parentMaxTokens: PROFILE.chunking.parentMaxTokens,
    });
    failure(
        children.length > 0 &&
            children.length <= 8 &&
            layout.parents.length <= 8,
        'PLANNER_BOUND'
    );
    return { children, ...layout };
}
/** Drain both independently owned readers even when one rejects; publish only after final admission. */
export async function finalizeVectorObservation({
    app,
    pool,
    recheck,
    publish,
}) {
    return finalizeCleanupObservation({
        objects: { close: () => {} },
        client: {
            $disconnect: async () => {
                const results = await Promise.allSettled([
                    Promise.resolve().then(() => app?.$disconnect()),
                    Promise.resolve().then(() => pool?.end()),
                ]);
                failure(
                    results.every((row) => row.status === 'fulfilled'),
                    'READER_CLOSE'
                );
            },
        },
        recheck,
        publish,
    });
}
async function main() {
    failure(!STATIC_DRAFT_ONLY, 'OBSERVER_DRAFT_REVIEW_REQUIRED');
    const args = process.argv.slice(2),
        phase = parseVectorArgs(args, '--phase', VECTOR_PHASES),
        purpose =
            phase === 'vector-g2-staged'
                ? 'staged-observe'
                : phase === 'vector-outage-failed'
                  ? 'outage-observe'
                  : 'observe';
    const { state, directory, recheck } = context(args.slice(0, 4), purpose),
        fixture = privateJson(path.join(directory, 'fixture.json'), 16384),
        binding = privateJson(
            path.join(
                directory,
                phase === 'vector-g1-ready'
                    ? 'vector-g1-bindings.json'
                    : 'vector-g2-bindings.json'
            ),
            16384
        );
    failure(
        sameScope(state, fixture) && sameScope(state, binding),
        'RECEIPT_SCOPE'
    );
    binding.organizationId = fixture.organization.id;
    const baseline =
        phase === 'vector-g1-ready'
            ? null
            : privateJson(
                  path.join(directory, 'observe-vector-g1-ready.json'),
                  32768
              );
    failure(
        !baseline ||
            (sameScope(state, baseline) &&
                baseline.phase === 'vector-g1-ready' &&
                baseline.status === 'OBSERVED'),
        'BASELINE_SCOPE'
    );
    const referenceNames = [
        'fixture.json',
        phase === 'vector-g1-ready'
            ? 'vector-g1-bindings.json'
            : 'vector-g2-bindings.json',
        ...(phase === 'vector-g1-ready'
            ? ['vector-search-g1-receipt.json']
            : ['observe-vector-g1-ready.json']),
    ];
    const references = referenceNames.map((name) => [
        name,
        sha(privateBytes(path.join(directory, name), 32768)),
    ]);
    const previousPhase = VECTOR_PHASES[VECTOR_PHASES.indexOf(phase) - 1],
        previous = previousPhase
            ? privateJson(
                  path.join(directory, `observe-${previousPhase}.json`),
                  32768
              )
            : null;
    if (previousPhase)
        references.push([
            `observe-${previousPhase}.json`,
            sha(
                privateBytes(
                    path.join(directory, `observe-${previousPhase}.json`),
                    32768
                )
            ),
        ]);
    failure(
        !previous ||
            (sameScope(state, previous) &&
                previous.phase === previousPhase &&
                previous.status === 'OBSERVED'),
        'PHASE_CHAIN'
    );
    writePrivate(path.join(directory, `observe-${phase}-intent.json`), {
        ...receiptScope(state),
        phase,
        status: 'ONE_SHOT_READ_ONLY',
    });
    let app,
        pool,
        result,
        finalizationStarted = false,
        until = performance.now() + 120000;
    const trace = [];
    let snapshots = 0,
        ackBytes = null;
    const finalGuard = () => {
        failure(performance.now() < until, 'OBSERVATION_DEADLINE');
        recheck(
            Math.max(1, Math.min(120000, Math.floor(until - performance.now())))
        );
        failure(
            performance.now() < until &&
                references.every(
                    ([name, hash]) =>
                        sha(privateBytes(path.join(directory, name), 32768)) ===
                        hash
                ),
            'REFERENCE_DRIFT_OR_DEADLINE'
        );
        failure(
            !fs.existsSync(
                path.join(directory, 'watchdog-intervention.json')
            ) &&
                (!ackBytes ||
                    sha(
                        privateBytes(
                            path.join(directory, 'watchdog-ack.json'),
                            16384
                        )
                    ) === sha(ackBytes)),
            'INTERVENTION'
        );
    };
    try {
        const original = readVectorOriginal(state),
            layout = await preparedLayout(state, original);
        finalGuard();
        app = await openFixturePrisma(state, true);
        const read = async () => {
            finalGuard();
            const value = await readVectorAppSnapshot(app, fixture, binding);
            finalGuard();
            return value;
        };
        let value,
            assessment,
            physical = { scope: 'DB_ONLY_VECTOR_OFFLINE', requests: 0 };
        if (phase === 'vector-outage-failed') {
            ackBytes = privateBytes(
                path.join(directory, 'watchdog-ack.json'),
                16384
            );
            const ack = JSON.parse(ackBytes);
            failure(sameScope(state, ack), 'ACK_SCOPE');
            const deadline = watchdogTraceDeadline(ack, state.runId);
            until = deadline;
            while (true) {
                failure(
                    snapshots++ < 360 && performance.now() < deadline,
                    'TRACE_DEADLINE'
                );
                value = await read();
                failure(performance.now() < deadline, 'TRACE_DEADLINE');
                failure(
                    value.collection?.activeGenerationId === binding.g1 &&
                        value.generations.find((g) => g.id === binding.g1)
                            ?.status === 'ACTIVE' &&
                        value.generations.find((g) => g.id === binding.g2)
                            ?.status === 'PROVISIONING' &&
                        value.candidates
                            .filter((p) => p.generationId === binding.g2)
                            .every(
                                (p) =>
                                    p.publishedAt === null &&
                                    p.vectorSealedAt === null
                            ),
                    'OUTAGE_POINTER'
                );
                const provision = value.tasks.find(
                    (t) =>
                        t.generationId === binding.g2 && t.kind === 'PROVISION'
                );
                // A live claim can be between observations; record only completed failure schedules.
                if (
                    value.liveClaims === 0 &&
                    provision?.errorCode === 'VECTOR_UNAVAILABLE'
                ) {
                    assessment = assessVectorSnapshot(
                        value,
                        provision.status === 'FAILED'
                            ? phase
                            : 'vector-progress',
                        fixture,
                        binding,
                        state,
                        layout
                    );
                    assertVectorContinuity({
                        phase,
                        binding,
                        assessment,
                        physical,
                        baseline,
                        previous,
                    });
                    const row = assessment.provision;
                    if (
                        !trace.length ||
                        canonical(row) !== canonical(trace.at(-1))
                    ) {
                        failure(trace.length < 11, 'TRACE_BOUND');
                        trace.push(row);
                    }
                    if (provision.status === 'FAILED') break;
                }
                await waitForNextSnapshot(performance.now() + 2000, deadline);
            }
            validateVectorTrace(trace);
        } else {
            value = await read();
            snapshots++;
            assessment = assessVectorSnapshot(
                value,
                phase,
                fixture,
                binding,
                state,
                layout
            );
            pool = await vectorPool(state);
            finalGuard();
            physical = await readPhysicalVector(
                pool,
                state,
                binding,
                assessment,
                { remainingMilliseconds: () => until - performance.now() }
            );
            const after = await read();
            failure(
                canonical({ ...after, observedAt: null }) ===
                    canonical({ ...value, observedAt: null }),
                'POST_PHYSICAL_METADATA_DRIFT'
            );
            for (const g of physical.generations)
                if (g.provisioned) {
                    failure(
                        g.destinationFingerprint ===
                            value.generations.find(
                                (r) => r.id === g.generationId
                            ).destinationFingerprint,
                        'DESTINATION_BINDING'
                    );
                    for (const row of g.rows) {
                        const appRow = value.chunks.find(
                            (r) => r.id === row.id
                        );
                        failure(
                            appRow &&
                                row.vectorHash ===
                                    sha(
                                        '[' +
                                            syntheticVector(appRow.text).join(
                                                ','
                                            ) +
                                            ']'
                                    ),
                            'PHYSICAL_VECTOR_HASH'
                        );
                    }
                    delete g.rows;
                }
        }
        assertVectorContinuity({
            phase,
            binding,
            assessment,
            physical,
            baseline,
            previous,
        });
        if (phase === 'vector-g1-ready') {
            const search = privateJson(
                path.join(directory, 'vector-search-g1-receipt.json'),
                16384
            );
            failure(
                sameScope(state, search) &&
                    search.generationId === binding.g1 &&
                    search.publicationId ===
                        assessment.manifests[0].publicationId &&
                    search.originalSha256 === binding.originalSha256,
                'BASELINE_SEARCH_RECONCILIATION'
            );
        }
        const common = {
                schemaVersion: 1,
                organizationId: fixture.organization.id,
                documentId: binding.documentId,
                versionId: binding.versionId,
                version: 1,
                originalSha256: binding.originalSha256,
                observedAt: value.observedAt,
                activeGenerationId: binding.g1,
            },
            process = {
                workerPid: state.processes.workers.pid,
                workerStartTicks: state.processes.workers.startTicks,
                vectorContainerId: state.resources.vector.id,
            };
        result = {
            ...receiptScope(state),
            namespace: state.namespace,
            phase,
            status: 'OBSERVED',
            ...assessment,
            physical,
            snapshots,
            trace: trace.length
                ? { changes: trace, ...validateVectorTrace(trace) }
                : null,
            metadataSha256: sha(canonical(value)),
            syntheticEmbedding: true,
            qualityAcceptance: 'NOT_MEASURED',
            crossStoreConsistency:
                phase === 'vector-outage-failed'
                    ? 'DB_ONLY_NOT_VECTOR_READABILITY'
                    : 'APP_METADATA_RECHECKED_NOT_CROSS_STORE_ATOMIC',
            ...(phase === 'vector-g1-ready'
                ? {
                      faultEnrollmentAdmission: {
                          ...common,
                          ...process,
                          kind: 'VECTOR_G1_READY_IDLE',
                          liveClaims: 0,
                      },
                  }
                : {}),
            ...(phase === 'vector-g2-staged'
                ? {
                      faultAdmission: {
                          ...common,
                          ...process,
                          kind: 'VECTOR_PROVISION_ACCEPTED',
                          targetGenerationId: binding.g2,
                          taskId: assessment.provision.id,
                          status: 'PENDING',
                          attempts: 0,
                          provisioned: false,
                          liveClaims: 0,
                      },
                  }
                : {}),
            ...(phase === 'vector-outage-failed'
                ? {
                      faultRecoveryAdmission: {
                          ...common,
                          kind: 'VECTOR_PROVISION_FAILED',
                          targetGenerationId: binding.g2,
                          taskId: assessment.provision.id,
                          status: 'FAILED',
                          attempts: 5,
                          errorCode: 'VECTOR_UNAVAILABLE',
                      },
                  }
                : {}),
        };
        finalizationStarted = true;
        await finalizeVectorObservation({
            app,
            pool,
            recheck: finalGuard,
            publish: () => {
                writePrivate(
                    path.join(directory, `observe-${phase}.json`),
                    JSON.parse(canonical(result))
                );
                console.log(
                    JSON.stringify({
                        ...receiptScope(state),
                        completed: true,
                        phase,
                        status: 'OBSERVED',
                    })
                );
            },
        });
    } catch (error) {
        try {
            writePrivate(
                path.join(directory, `observe-${phase}-incomplete.json`),
                {
                    ...receiptScope(state),
                    phase,
                    status: 'INCOMPLETE',
                    snapshots,
                }
            );
        } catch {
            /* preserve intent */
        }
        throw error;
    } finally {
        if (!finalizationStarted) {
            const results = await Promise.allSettled([
                Promise.resolve().then(() => app?.$disconnect()),
                Promise.resolve().then(() => pool?.end()),
            ]);
            if (results.some((r) => r.status === 'rejected'))
                failure(false, 'READER_CLOSE');
        }
    }
}
if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
    main().catch(entryError);
