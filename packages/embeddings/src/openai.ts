import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { configurationUrl, operationSignal, requestJson } from './http';
import { observeEmbeddingBatch } from './batch-observer';
import { prepareEmbeddingInput } from './preparation';
import {
    EmbeddingError,
    openAIModelIdentity,
    type OpenAIConfiguration,
    type OpenAIModelIdentity,
    type ModelSummary,
    type RequestOptions,
    type VerifyEmbeddingOptions,
    type EmbeddingDocument,
    type EmbeddingOptions,
    type EmbeddingResult,
} from './types';

/** Reviewed shortening policy up to each model's natural size; selected dimensions still need a native probe. */
export const OPENAI_MODELS = {
    'text-embedding-3-small': {
        defaultDimensions: 1536,
        maximumDimensions: 1536,
    },
    'text-embedding-3-large': {
        defaultDimensions: 3072,
        maximumDimensions: 3072,
    },
} as const;
type OpenAIModel = keyof typeof OPENAI_MODELS;
const modelName = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const listedModels = z.object({
    object: z.literal('list'),
    data: z
        .array(
            z.object({
                id: z.string().min(1).max(200),
                object: z.literal('model').nullish(),
                created: tokens.nullish(),
                ['owned_by']: z.string().max(200).nullish(),
                ['shutdown_date']: z.string().max(64).nullish(),
            })
        )
        .max(1000),
});
const responseSchema = z.object({
    object: z.literal('list'),
    model: modelName,
    data: z
        .array(
            z.object({
                object: z.literal('embedding'),
                index: z.number().int().min(0).max(2047),
                embedding: z.array(z.number().finite()).min(1).max(3072),
            })
        )
        .min(1)
        .max(2048),
    usage: z
        .object({
            ['prompt_tokens']: tokens.nullish(),
            ['total_tokens']: tokens.nullish(),
        })
        .nullish(),
});
const INPUT_TOKEN_RESERVE = 32;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return parsed.data;
}

/** Native hosted model IDs are exact and case-sensitive; no implicit alias or Ollama tag is added. */
export function canonicalOpenAIModel(name: string): string {
    if (!modelName.safeParse(name).success)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    return name;
}
function supportedModel(name: string): OpenAIModel {
    canonicalOpenAIModel(name);
    if (!Object.hasOwn(OPENAI_MODELS, name))
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    return name as OpenAIModel;
}
function capabilityIdentity(
    model: OpenAIModel,
    size: number
): OpenAIModelIdentity {
    const caps = OPENAI_MODELS[model];
    if (!Number.isInteger(size) || size < 1 || size > caps.maximumDimensions)
        throw new EmbeddingError('DIMENSIONS_UNSUPPORTED');
    const profile = {
        schemaVersion: 4 as const,
        provider: 'OPENAI' as const,
        identityKind: 'CAPABILITY_PROFILE' as const,
        model,
        family: 'openai-embedding-3' as const,
        contextTokens: 8192 as const,
        defaultDimensions: caps.defaultDimensions,
        dimensions: size,
        dimensionCapability: {
            kind: 'RANGE' as const,
            minimum: 1 as const,
            maximum: caps.maximumDimensions,
            step: 1 as const,
        },
        supportedDimensions: [size],
        capabilities: ['embedding'],
        preset: 'GENERIC' as const,
        retrievalRoles: 'SHARED_INPUT' as const,
        encodingFormat: 'float' as const,
        truncation: 'UNSUPPORTED' as const,
        maxBatchInputs: 2048 as const,
        maxBatchTokens: 300_000 as const,
    };
    return {
        ...profile,
        digest: createHash('sha256')
            .update('vectorix:openai-capability-profile:v1\n')
            .update(JSON.stringify(profile))
            .digest('hex'),
    };
}
/** Reject altered persisted native semantics before I/O; this fingerprint cannot attest to hosted weights. */
function savedIdentity(value: OpenAIModelIdentity) {
    const parsed = openAIModelIdentity.safeParse(value);
    if (!parsed.success) throw new EmbeddingError('MODEL_CHANGED');
    const identity = parsed.data;
    if (
        !isDeepStrictEqual(
            identity,
            capabilityIdentity(identity.model, identity.dimensions)
        )
    )
        throw new EmbeddingError('MODEL_CHANGED');
    return identity;
}

/** Intersect the authenticated native listing with reviewed text models; listing never establishes embedding readiness. */
export async function discoverOpenAIModels(
    config: OpenAIConfiguration,
    options: RequestOptions = {}
): Promise<ModelSummary[]> {
    configurationUrl(config);
    const response = parse(
        listedModels,
        await requestJson(config, 'models', operationSignal(options))
    );
    const seen = new Set<string>();
    const models: ModelSummary[] = [];
    for (const entry of response.data) {
        if (seen.has(entry.id))
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
        seen.add(entry.id);
        if (!Object.hasOwn(OPENAI_MODELS, entry.id)) continue;
        const model = entry.id as OpenAIModel;
        const identity = capabilityIdentity(
            model,
            OPENAI_MODELS[model].defaultDimensions
        );
        models.push({
            model,
            digest: identity.digest,
            family: identity.family,
            identityKind: identity.identityKind,
            discoverySource: 'HOSTED_CATALOG',
            defaultDimensions: identity.defaultDimensions,
            dimensionCapability: identity.dimensionCapability,
            contextTokens: identity.contextTokens,
        });
    }
    return models;
}

async function batch(
    config: OpenAIConfiguration,
    identity: OpenAIModelIdentity,
    inputs: string[],
    signal: AbortSignal
) {
    const response = parse(
        responseSchema,
        await requestJson(config, 'embeddings', signal, {
            input: inputs,
            model: identity.model,
            dimensions: identity.dimensions,
            ['encoding_format']: identity.encodingFormat,
        })
    );
    if (
        response.model !== identity.model ||
        response.data.length !== inputs.length
    )
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    const ordered = new Map<number, number[]>();
    for (const row of response.data) {
        if (row.index >= inputs.length || ordered.has(row.index))
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
        let norm = 0;
        for (const value of row.embedding) {
            const rounded = Math.fround(value);
            if (!Number.isFinite(rounded))
                throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
            norm += rounded * rounded;
        }
        if (
            row.embedding.length !== identity.dimensions ||
            !Number.isFinite(norm) ||
            norm <= 0
        )
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
        ordered.set(row.index, row.embedding);
    }
    const prompt = response.usage?.prompt_tokens ?? null;
    const total = response.usage?.total_tokens ?? null;
    if (prompt !== null && total !== null && total < prompt)
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return {
        vectors: Array.from({ length: inputs.length }, (_, index) =>
            ordered.get(index)!
        ),
        providerInputTokens: prompt,
    };
}

/** Probe exact saved dimensions on both application paths; OpenAI has no native document/query role parameter. */
export async function verifyOpenAIEmbeddingModel(
    config: OpenAIConfiguration,
    input: VerifyEmbeddingOptions,
    options: RequestOptions = {}
): Promise<OpenAIModelIdentity> {
    configurationUrl(config);
    const model = supportedModel(input.model);
    if (input.preset !== 'GENERIC')
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    const identity = capabilityIdentity(model, input.dimensions);
    const signal = operationSignal(options);
    for (const kind of ['document', 'query'] as const) {
        const text = prepareEmbeddingInput(
            identity,
            kind,
            'Vectorix embedding capability check.',
            {
                preparation: input.preparation,
            }
        );
        await batch(config, identity, [text], signal);
    }
    return identity;
}

async function embed(
    config: OpenAIConfiguration,
    saved: OpenAIModelIdentity,
    values: EmbeddingDocument[],
    kind: 'document' | 'query',
    options: EmbeddingOptions
): Promise<EmbeddingResult> {
    configurationUrl(config);
    const identity = savedIdentity(saved);
    if (values.length < 1 || values.length > 4096)
        throw new EmbeddingError('INPUT_TOO_LARGE');
    const signal = operationSignal(options);
    const inputs = values.map((entry) =>
        prepareEmbeddingInput(identity, kind, entry.text, {
            preparation: options.preparation,
        })
    );
    const vectors: number[][] = [];
    let providerInputTokens: number | null = 0;
    let estimatedInputTokens = 0;
    let requests = 0;
    // The native 2048-input maximum is reduced to keep normal float JSON below the 8 MiB response ceiling.
    const batchLimit = Math.max(
        1,
        Math.min(
            identity.maxBatchInputs,
            Math.floor((7 * 1024 * 1024) / (identity.dimensions * 32))
        )
    );
    for (let position = 0; position < inputs.length;) {
        const texts: string[] = [];
        let encodedBytes = 0;
        let tokenBound = 0;
        while (position < inputs.length && texts.length < batchLimit) {
            const text = inputs[position]!;
            const bytes = Buffer.byteLength(JSON.stringify(text)) + 1;
            const bound = Buffer.byteLength(text) + INPUT_TOKEN_RESERVE;
            if (
                encodedBytes + bytes > 1024 * 1024 ||
                tokenBound + bound > identity.maxBatchTokens
            ) {
                if (!texts.length) throw new EmbeddingError('INPUT_TOO_LARGE');
                break;
            }
            encodedBytes += bytes;
            tokenBound += bound;
            texts.push(text);
            position++;
        }
        const result = await observeEmbeddingBatch(
            {
                identity,
                kind,
                ordinal: requests,
                inputOffset: position - texts.length,
                inputs: texts,
                options,
                signal,
            },
            () => batch(config, identity, texts, signal)
        );
        vectors.push(...result.vectors);
        requests++;
        estimatedInputTokens += result.usage.estimatedInputTokens;
        providerInputTokens =
            providerInputTokens === null ||
            result.usage.providerInputTokens === null
                ? null
                : providerInputTokens + result.usage.providerInputTokens;
        if (
            providerInputTokens !== null &&
            !Number.isSafeInteger(providerInputTokens)
        )
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    return {
        vectors,
        usage: { providerInputTokens, estimatedInputTokens, requests },
    };
}

/** Embed literal Generic document text; titles are not transformed into invented native prompts. */
export function embedOpenAIDocuments(
    config: OpenAIConfiguration,
    identity: OpenAIModelIdentity,
    values: EmbeddingDocument[],
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, values, 'document', options);
}

/** OpenAI query inputs use the same native wire protocol and preparation as document inputs. */
export function embedOpenAIQuery(
    config: OpenAIConfiguration,
    identity: OpenAIModelIdentity,
    text: string,
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, [{ text }], 'query', options);
}
