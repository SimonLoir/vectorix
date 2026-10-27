import { z } from 'zod';
import { isRerankingModelId, RERANKING_LIMITS } from './models';
import { configurationUrl, operationSignal, requestJson } from './http';
import {
    assertTeiModelAndPool,
    parseTeiInfo,
    type TeiRuntimeSnapshot,
} from './tei-snapshot';
import {
    RerankingError,
    type TeiProbeConfiguration,
    type RerankingOptions,
    type RerankingResult,
} from './types';

export type TeiProbeInput = Readonly<{ model: string; candidatePool: number }>;

/** One bounded metadata-only GET. This never performs model inference or returns private native diagnostics. */
export async function inspectTei(
    configuration: TeiProbeConfiguration,
    input: TeiProbeInput,
    signal: AbortSignal
): Promise<TeiRuntimeSnapshot> {
    if (!configuration || configuration.provider !== 'TEI')
        throw new RerankingError('INVALID_CONFIGURATION');
    if (!input || !isRerankingModelId(input.model))
        throw new RerankingError('MODEL_UNSUPPORTED');
    if (
        !Number.isInteger(input.candidatePool) ||
        input.candidatePool < 1 ||
        input.candidatePool > RERANKING_LIMITS.documents
    )
        throw new RerankingError('INPUT_TOO_LARGE');
    const url = new URL('info', configurationUrl(configuration));
    const model = input.model;
    const candidatePool = input.candidatePool;
    const response = await requestJson(
        url,
        configuration.apiKey,
        undefined,
        signal
    );
    const runtime = parseTeiInfo(response.data, candidatePool);
    assertTeiModelAndPool(runtime, model, candidatePool);
    return runtime;
}

/** Probe an operator-allowlisted TEI destination before saving a profile; the caller rechecks authority after I/O. */
export async function probeTei(
    configuration: TeiProbeConfiguration,
    input: TeiProbeInput,
    options: RerankingOptions = {}
) {
    return await inspectTei(configuration, input, operationSignal(options));
}

const scores = z
    .array(
        z.object({
            index: z.number().int().nonnegative(),
            score: z.number().min(0).max(1),
        })
    )
    .min(1)
    .max(100);

/** A header is an optional native compute observation, never a billed unit or an estimate. */
function computeTokens(headers: Headers) {
    const value = headers.get('x-compute-tokens');
    if (value === null) return null;
    if (
        !/^(0|[1-9][0-9]*)$/.test(value) ||
        !Number.isSafeInteger(Number(value))
    )
        throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    return Number(value);
}

/** TEI normalized single-label scores must cover every child index once; raw logits and echoed text are never consumed. */
export function parseTeiResponse(
    value: unknown,
    headers: Headers,
    count: number
): Omit<RerankingResult, 'durationMs'> {
    const parsed = scores.safeParse(value);
    if (
        !parsed.success ||
        parsed.data.length !== count ||
        new Set(parsed.data.map((row) => row.index)).size !== count ||
        parsed.data.some((row) => row.index >= count)
    )
        throw new RerankingError('INVALID_PROVIDER_RESPONSE');
    return {
        results: parsed.data.toSorted(
            (left, right) =>
                right.score - left.score || left.index - right.index
        ),
        usage: {
            providerInputTokens: computeTokens(headers),
            billedInputTokens: null,
            billedSearchUnits: null,
        },
    };
}
