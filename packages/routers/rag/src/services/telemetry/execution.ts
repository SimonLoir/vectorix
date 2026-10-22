import type { EmbeddingNumericEvent } from '@repo/embeddings';
import { intervalUnionMicros, phaseSample } from './numeric';
import type {
    TelemetryDelta,
    TelemetryExecution,
    TelemetryPhase,
    TelemetryTags,
} from './types';

/** Keep one bounded claim/request sample per phase, including disjoint VECTOR spans. */
export function telemetryExecution(
    tags: TelemetryTags,
    observe: (delta: TelemetryDelta) => void,
    started = performance.now()
): TelemetryExecution {
    const totals = new Map<TelemetryPhase, number>();
    const internal: [number, number][] = [];
    let finished = false;
    observe({ recordedStarts: 1n });
    const search = tags.workload.startsWith('SEARCH_');
    const nativeObserver = (event: EmbeddingNumericEvent) => {
        if (event.provider !== tags.provider) return;
        if (event.outcome === 'START') {
            observe({
                nativeStarts: 1n,
                dispatchedPreparedBytes: BigInt(event.preparedInputBytes),
            });
        } else if (event.outcome === 'FAILED') {
            observe({ nativeFailedBatches: 1n });
        } else {
            observe({
                nativeValidatedBatches: 1n,
                validatedVectors: BigInt(event.validatedVectors),
                validatedPreparedBytes: BigInt(event.preparedInputBytes),
                validatedEstimatedInputTokens: BigInt(
                    event.estimatedInputTokens
                ),
                ...(event.providerInputTokens === null
                    ? { unknownProviderTokenBatches: 1n }
                    : {
                          knownProviderInputTokens: BigInt(
                              event.providerInputTokens
                          ),
                      }),
                ...(event.billedInputTokens === null
                    ? { unknownBilledTokenBatches: 1n }
                    : { knownBilledInputTokens: event.billedInputTokens }),
            });
        }
    };
    const phase = (name: TelemetryPhase, beginning = performance.now()) => {
        let closed = false;
        return () => {
            if (closed || finished) return;
            closed = true;
            const end = performance.now();
            totals.set(
                name,
                (totals.get(name) ?? 0) + Math.max(0, end - beginning)
            );
            if (
                search &&
                ['PREFLIGHT', 'LEXICAL', 'VECTOR', 'FUSION_HYDRATE'].includes(
                    name
                ) &&
                internal.length < 5
            )
                internal.push([beginning, end]);
        };
    };
    return {
        phase,
        async measure(name, operation) {
            const close = phase(name);
            try {
                return await operation();
            } finally {
                close();
            }
        },
        sourceRead(bytes) {
            observe({ sourceReadBytes: BigInt(bytes) });
        },
        artifactWritten(bytes) {
            observe({ artifactWrittenBytes: BigInt(bytes) });
        },
        nativeObserver,
        finish(outcome, failure) {
            if (finished) return;
            finished = true;
            const phaseStats: NonNullable<TelemetryDelta['phaseStats']> =
                Object.fromEntries(
                    [...totals].map(([name, milliseconds]) => [
                        name,
                        phaseSample(
                            Math.max(0, Math.round(milliseconds * 1000))
                        ),
                    ])
                );
            const finalPhases = {
                ...phaseStats,
                [search ? 'SERVICE_TOTAL' : 'EXECUTION_TOTAL']: phaseSample(
                    Math.max(
                        0,
                        Math.round((performance.now() - started) * 1000)
                    )
                ),
                ...(search
                    ? {
                          INTERNAL_PHASE_UNION: phaseSample(
                              intervalUnionMicros(internal)
                          ),
                      }
                    : {}),
            };
            const counters = {
                SUCCESS: 'recordedSuccesses',
                FAILURE: 'recordedFailures',
                CONTINUATION: 'recordedContinuations',
                SUPERSEDED: 'recordedSupersessions',
                DENIED: 'recordedDenials',
            } as const;
            observe({
                [counters[outcome]]: 1n,
                phaseStats: finalPhases,
                ...(failure ? { failureCounts: { [failure]: 1n } } : {}),
            });
        },
    };
}
