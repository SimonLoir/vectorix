import { configurationUrl, operationSignal, requestJson } from './http';
import { prepareRerankingInput } from './input';
import { RerankingError } from './types';
import { parseRerankingResponse } from './protocol';
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
} from './models';
export type { RerankingModel } from './models';
export { validateRerankingInput } from './input';
export { RerankingError } from './types';
export type {
    RerankingConfiguration,
    RerankingErrorCode,
    RerankingInput,
    RerankingInputStatistics,
    RerankingOptions,
    RerankingProvider,
    RerankingResult,
    RerankingScore,
    RerankingUsage,
} from './types';

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
    const response = await requestJson(
        url,
        configuration.apiKey,
        prepared.encoded,
        signal
    );
    const parsed = parseRerankingResponse(
        configuration.provider,
        prepared.model,
        prepared.statistics.candidateCount,
        response
    );
    if (signal.aborted) throw new RerankingError('PROVIDER_TIMEOUT');
    return { ...parsed, durationMs: Math.max(0, performance.now() - started) };
}
