import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { requestJson, operationSignal } from './http';
import { prepareEmbeddingInput } from './preparation';
import {
    EmbeddingError,
    ollamaModelIdentity,
    type OllamaConfiguration,
    type OllamaModelIdentity,
    type ModelSummary,
    type RequestOptions,
    type VerifyEmbeddingOptions,
    type EmbeddingOptions,
    type EmbeddingDocument,
    type EmbeddingResult,
} from './types';

const modelName = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/);
const digest = z
    .string()
    .regex(/^(sha256:)?[a-f0-9]{64}$/)
    .transform((value) => value.replace(/^sha256:/, ''));
const tags = z.object({
    models: z
        .array(
            z.object({
                model: modelName.optional(),
                name: modelName,
                digest,
                details: z
                    .object({ family: z.string().min(1).max(100) })
                    .optional(),
            })
        )
        .max(512),
});
const show = z.object({
    details: z.object({ family: z.string().min(1).max(100) }),
    ['model_info']: z.record(z.string(), z.unknown()),
    capabilities: z.array(z.string().min(1).max(100)).max(32),
});
const embedResponse = z.object({
    model: modelName,
    embeddings: z
        .array(z.array(z.number().finite()).min(1).max(4096))
        .min(1)
        .max(128),
    ['prompt_eval_count']: z
        .number()
        .int()
        .nonnegative()
        .max(Number.MAX_SAFE_INTEGER)
        .optional(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown) {
    const result = schema.safeParse(value);
    if (!result.success) throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return result.data;
}
/** Normalize Ollama's explicit default tag without changing namespaces or registry hosts. */
export function canonicalOllamaModel(name: string) {
    if (!modelName.safeParse(name).success)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    return name.split('/').at(-1)?.includes(':') ? name : `${name}:latest`;
}
async function models(
    config: OllamaConfiguration,
    signal: AbortSignal
): Promise<ModelSummary[]> {
    const response = parse(tags, await requestJson(config, 'api/tags', signal));
    const result = response.models.map((entry) => ({
        model: canonicalOllamaModel(entry.model ?? entry.name),
        digest: entry.digest,
        family: entry.details?.family ?? 'unknown',
    }));
    if (new Set(result.map((entry) => entry.model)).size !== result.length)
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return result;
}
function selectModel(models: ModelSummary[], name: string) {
    const selected = models.find(
        (entry) => entry.model === canonicalOllamaModel(name)
    );
    if (!selected) throw new EmbeddingError('MODEL_NOT_FOUND');
    return selected;
}
async function assertManifest(
    config: OllamaConfiguration,
    identity: Pick<OllamaModelIdentity, 'model' | 'digest'>,
    signal: AbortSignal
) {
    const selected = selectModel(await models(config, signal), identity.model);
    if (selected.digest !== identity.digest)
        throw new EmbeddingError('MODEL_CHANGED');
}
function validateVectors(
    value: unknown,
    count: number,
    dimensions: number,
    expectedModel: string
) {
    const response = parse(embedResponse, value);
    if (
        canonicalOllamaModel(response.model) !==
            canonicalOllamaModel(expectedModel) ||
        response.embeddings.length !== count
    )
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    for (const vector of response.embeddings) {
        // Persistence uses float32. Validate that representation before an invalid
        // provider vector can be misclassified as a destination/storage failure.
        const norm = vector.reduce((sum, number) => {
            const rounded = Math.fround(number);
            if (!Number.isFinite(rounded))
                throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
            return sum + rounded * rounded;
        }, 0);
        if (vector.length !== dimensions || !Number.isFinite(norm) || norm <= 0)
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    return response;
}
/** Discover only installed native Ollama models; discovery never downloads or creates a model. */
export function discoverModels(
    config: OllamaConfiguration,
    options: RequestOptions = {}
) {
    return models(config, operationSignal(options));
}
/** Persist verified model metadata and a probed dimension choice, rather than trusting a user-entered vector size. */
export async function verifyEmbeddingModel(
    config: OllamaConfiguration,
    input: VerifyEmbeddingOptions,
    options: RequestOptions = {}
): Promise<OllamaModelIdentity> {
    const signal = operationSignal(options);
    const selected = selectModel(await models(config, signal), input.model);
    const detail = parse(
        show,
        await requestJson(config, 'api/show', signal, {
            model: selected.model,
            verbose: false,
        })
    );
    if (!detail.capabilities.includes('embedding'))
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    const architecture = detail.model_info['general.architecture'];
    if (
        typeof architecture !== 'string' ||
        !/^[a-zA-Z0-9_]{1,100}$/.test(architecture)
    )
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    const contextTokens = detail.model_info[`${architecture}.context_length`];
    const defaultDimensions =
        detail.model_info[`${architecture}.embedding_length`];
    const gemma =
        selected.model.split('/').at(-1)?.split(':')[0] === 'embeddinggemma' &&
        architecture === 'gemma3' &&
        defaultDimensions === 768;
    if (input.preset === 'EMBEDDING_GEMMA' && !gemma)
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    const dimensions = gemma ? [128, 256, 512, 768] : [defaultDimensions];
    if (!dimensions.includes(input.dimensions))
        throw new EmbeddingError('DIMENSIONS_UNSUPPORTED');
    const candidate = ollamaModelIdentity.safeParse({
        schemaVersion: 1,
        provider: 'OLLAMA',
        model: selected.model,
        digest: selected.digest,
        family: detail.details.family,
        architecture,
        contextTokens,
        defaultDimensions,
        dimensions: input.dimensions,
        supportedDimensions: dimensions,
        capabilities: detail.capabilities,
        preset: input.preset,
    });
    if (!candidate.success)
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    const identity = candidate.data;
    const probeText = prepareEmbeddingInput(
        identity,
        'document',
        'Vectorix embedding capability check.',
        { preparation: input.preparation }
    );
    // Probe native default output and the exact requested dimensions. A server ignoring dimensions is rejected.
    validateVectors(
        await requestJson(config, 'api/embed', signal, {
            model: identity.model,
            input: [probeText],
            truncate: false,
        }),
        1,
        identity.defaultDimensions,
        identity.model
    );
    if (identity.dimensions !== identity.defaultDimensions)
        validateVectors(
            await requestJson(config, 'api/embed', signal, {
                model: identity.model,
                input: [probeText],
                dimensions: identity.dimensions,
                truncate: false,
            }),
            1,
            identity.dimensions,
            identity.model
        );
    await assertManifest(config, identity, signal);
    return identity;
}
async function embed(
    config: OllamaConfiguration,
    saved: OllamaModelIdentity,
    values: EmbeddingDocument[],
    kind: 'document' | 'query',
    options: EmbeddingOptions
): Promise<EmbeddingResult> {
    const identity = parse(ollamaModelIdentity, saved);
    if (values.length < 1 || values.length > 4096)
        throw new EmbeddingError('INPUT_TOO_LARGE');
    const signal = operationSignal(options);
    const inputs = values.map((entry) =>
        prepareEmbeddingInput(identity, kind, entry.text, {
            title: entry.title,
            preparation: options.preparation,
        })
    );
    const vectors: number[][] = [];
    let providerInputTokens: number | null = 0;
    let estimatedInputTokens = 0;
    let requests = 0;
    // Limit both vector response and request bytes independently of the maximum batch count.
    const batchLimit = Math.max(
        1,
        Math.min(
            128,
            Math.floor((7 * 1024 * 1024) / (identity.dimensions * 24))
        )
    );
    for (let position = 0; position < inputs.length;) {
        const batch: string[] = [];
        let bytes = 0;
        while (position < inputs.length && batch.length < batchLimit) {
            const input = inputs[position]!;
            const size = Buffer.byteLength(JSON.stringify(input));
            if (bytes + size > 1024 * 1024 && batch.length) break;
            bytes += size;
            batch.push(input);
            position++;
        }
        await assertManifest(config, identity, signal);
        const response = validateVectors(
            await requestJson(config, 'api/embed', signal, {
                model: identity.model,
                input: batch,
                dimensions: identity.dimensions,
                truncate: false,
            }),
            batch.length,
            identity.dimensions,
            identity.model
        );
        // Ollama's embed response has a model name, no cryptographic manifest identity. This detects ordinary replacements, not hostile ABA swaps.
        await assertManifest(config, identity, signal);
        vectors.push(...response.embeddings);
        requests++;
        estimatedInputTokens += batch.reduce(
            (sum, input) => sum + Math.ceil(Buffer.byteLength(input) / 4),
            0
        );
        if (response.prompt_eval_count === undefined)
            providerInputTokens = null;
        else if (providerInputTokens !== null) {
            providerInputTokens += response.prompt_eval_count;
            if (!Number.isSafeInteger(providerInputTokens))
                throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
        }
    }
    return {
        vectors,
        usage: { providerInputTokens, estimatedInputTokens, requests },
    };
}
/** Native document embedding uses the immutable generation identity and explicit saved preparation. */
export function embedDocuments(
    config: OllamaConfiguration,
    identity: OllamaModelIdentity,
    values: EmbeddingDocument[],
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, values, 'document', options);
}
/** Query embedding is a distinct role; GENERIC remains raw input and EmbeddingGemma applies its documented query task. */
export function embedQuery(
    config: OllamaConfiguration,
    identity: OllamaModelIdentity,
    text: string,
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, [{ text }], 'query', options);
}
