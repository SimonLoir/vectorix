import { configurationUrl, operationSignal, requestJson } from './http';
import { prepareRerankingInput } from './input';
import { RerankingError } from './types';
import { parseRerankingResponse } from './protocol';
import { inspectTei, parseTeiResponse } from './tei';
import {
    assertTeiModelAndPool,
    matchesTeiRuntime,
    parseTeiRuntimeSnapshot,
} from './tei-snapshot';
import type {
    RerankingConfiguration,
    RerankingInput,
    RerankingOptions,
    RerankingResult,
} from './types';

export {
    RERANKING_MODELS,
    RERANKING_LIMITS,
    listRerankingModels,
    isRerankingModelId,
    supportsRerankingModel,
    rerankingScoreKind,
} from './models';
export type {
    RerankingModel,
    HostedRerankingProvider,
    RerankingScoreKind,
} from './models';
export { probeTei } from './tei';
export type { TeiProbeInput } from './tei';
export { parseTeiRuntimeSnapshot } from './tei-snapshot';
export type { TeiRuntimeSnapshot } from './tei-snapshot';
export { validateRerankingInput } from './input';
export { RerankingError } from './types';
export type {
    RerankingConfiguration,
    TeiProbeConfiguration,
    RerankingErrorCode,
    RerankingInput,
    RerankingInputStatistics,
    RerankingOptions,
    RerankingProvider,
    RerankingResult,
    RerankingScore,
    RerankingUsage,
} from './types';

/** Keep caller authority failures outside native HTTP error sanitization and never dispatch after admission expires. */
async function beforeInference(
    admit: RerankingOptions['beforeInference'],
    signal: AbortSignal
) {
    if (signal.aborted) throw new RerankingError('PROVIDER_TIMEOUT');
    await admit?.();
    if (signal.aborted) throw new RerankingError('PROVIDER_TIMEOUT');
}

/**
 * One bounded native provider request, without retries, redirects or fallback.
 * Callers must authorize the candidate texts and allowlist the endpoint before calling.
 */
export async function rerank(
    configuration: RerankingConfiguration,
    input: RerankingInput,
    options: RerankingOptions = {}
): Promise<RerankingResult> {
    const started = performance.now();
    const signal = operationSignal(options);
    const url = configurationUrl(configuration);
    const prepared = prepareRerankingInput(configuration.provider, input);
    const apiKey = configuration.apiKey;
    const admit = options.beforeInference;
    if (configuration.provider === 'TEI') {
        const saved = parseTeiRuntimeSnapshot(configuration.runtimeSnapshot);
        assertTeiModelAndPool(
            saved,
            prepared.model,
            prepared.statistics.candidateCount
        );
        const live = await inspectTei(
            { provider: 'TEI', endpoint: configuration.endpoint, apiKey },
            {
                model: prepared.model,
                candidatePool: prepared.statistics.candidateCount,
            },
            signal
        );
        if (!matchesTeiRuntime(saved, live))
            throw new RerankingError('MODEL_CHANGED');
        await beforeInference(admit, signal);
        const response = await requestJson(
            url,
            apiKey,
            prepared.encoded,
            signal
        );
        const parsed = parseTeiResponse(
            response.data,
            response.headers,
            prepared.statistics.candidateCount
        );
        if (signal.aborted) throw new RerankingError('PROVIDER_TIMEOUT');
        return {
            ...parsed,
            durationMs: Math.max(0, performance.now() - started),
        };
    }
    const provider = configuration.provider;
    await beforeInference(admit, signal);
    const response = await requestJson(url, apiKey, prepared.encoded, signal);
    const parsed = parseRerankingResponse(
        provider,
        prepared.model,
        prepared.statistics.candidateCount,
        response.data
    );
    if (signal.aborted) throw new RerankingError('PROVIDER_TIMEOUT');
    return { ...parsed, durationMs: Math.max(0, performance.now() - started) };
}
