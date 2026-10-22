import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { configurationUrl, operationSignal, requestJson } from './http';
import { prepareEmbeddingInput } from './preparation';
import {
    EmbeddingError,
    mistralModelIdentity,
    type MistralConfiguration,
    type MistralModelIdentity,
    type ModelSummary,
    type RequestOptions,
    type VerifyEmbeddingOptions,
    type EmbeddingDocument,
    type EmbeddingOptions,
    type EmbeddingResult,
} from './types';

const aliases = ['mistral-embed', 'mistral-embed-2312'] as const;
/** Reviewed fixed-dimension aliases only; 8000 is a conservative processing policy for the documented 8k context. */
export const MISTRAL_MODELS = {
    'mistral-embed': { contextTokens: 8000, dimensions: 1024 },
    'mistral-embed-2312': { contextTokens: 8000, dimensions: 1024 },
} as const;
type MistralModel = keyof typeof MISTRAL_MODELS;
const modelName = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const listedModels = z.object({
    object: z.string().max(200).default('list'),
    data: z
        .array(
            z.object({
                id: z.string().min(1).max(200),
                aliases: z.array(z.string().min(1).max(200)).max(100).nullish(),
                object: z.string().max(200).nullish().default('model'),
                created: tokens.nullish(),
                ['owned_by']: z.string().max(200).nullish(),
                ['max_context_length']: tokens.nullish(),
            })
        )
        .max(1000)
        .default([]),
});
const responseSchema = z.object({
    object: z.string().max(200),
    model: modelName,
    data: z
        .array(
            z.object({
                object: z.string().max(200).optional(),
                index: z.number().int().min(0).max(63),
                embedding: z.array(z.number().finite()).length(1024),
            })
        )
        .min(1)
        .max(64),
    usage: z
        .object({
            ['prompt_tokens']: tokens.nullish(),
            ['total_tokens']: tokens.nullish(),
        })
        .nullish(),
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return parsed.data;
}
/** Keep the requested official alias exact; never substitute a model ID or infer an Ollama tag. */
export function canonicalMistralModel(name: string): string {
    if (!modelName.safeParse(name).success)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    return name;
}
function isReviewedModel(name: string): name is MistralModel {
    return Object.hasOwn(MISTRAL_MODELS, name);
}
function supportedModel(name: string): MistralModel {
    canonicalMistralModel(name);
    if (!isReviewedModel(name)) throw new EmbeddingError('MODEL_UNSUPPORTED');
    return name;
}
function capabilityProfile(model: MistralModel) {
    return {
        schemaVersion: 5 as const,
        provider: 'MISTRAL' as const,
        identityKind: 'CAPABILITY_PROFILE' as const,
        model,
        equivalentModels: [...aliases] as [
            'mistral-embed',
            'mistral-embed-2312',
        ],
        family: 'mistral-embed' as const,
        contextTokens: 8000 as const,
        defaultDimensions: 1024 as const,
        dimensions: 1024 as const,
        supportedDimensions: [1024] as 1024[],
        capabilities: ['embedding'],
        preset: 'GENERIC' as const,
        retrievalRoles: 'SHARED_INPUT' as const,
        encodingFormat: 'float' as const,
        truncation: 'UNSUPPORTED' as const,
        batchPolicy: {
            maxInputs: 64 as const,
            maxPreparedInputBytes: 16_000 as const,
            inputTokenReserve: 32 as const,
        },
    };
}
function fingerprint(profile: object) {
    return createHash('sha256')
        .update('vectorix:mistral-capability-profile:v1\n')
        .update(JSON.stringify(profile))
        .digest('hex');
}
function capabilityIdentity(
    model: MistralModel,
    responseModel: MistralModel
): MistralModelIdentity {
    const profile = { ...capabilityProfile(model), responseModel };
    return { ...profile, digest: fingerprint(profile) };
}
/** Persisted native semantics and the observed response ID must match the full reviewed snapshot before replay I/O. */
function savedIdentity(value: MistralModelIdentity) {
    const parsed = mistralModelIdentity.safeParse(value);
    if (!parsed.success) throw new EmbeddingError('MODEL_CHANGED');
    const identity = parsed.data;
    if (
        !isDeepStrictEqual(
            identity,
            capabilityIdentity(identity.model, identity.responseModel)
        )
    )
        throw new EmbeddingError('MODEL_CHANGED');
    return identity;
}

/** Native model cards have aliases but no embeddings flag. Only reviewed IDs and their reviewed aliases enter this text catalog. */
export async function discoverMistralModels(
    config: MistralConfiguration,
    options: RequestOptions = {}
): Promise<ModelSummary[]> {
    configurationUrl(config);
    const response = parse(
        listedModels,
        await requestJson(config, 'models', operationSignal(options))
    );
    const seen = new Set<string>();
    const available = new Set<MistralModel>();
    for (const entry of response.data) {
        if (seen.has(entry.id))
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
        seen.add(entry.id);
        if (!isReviewedModel(entry.id)) continue;
        available.add(entry.id);
        for (const alias of entry.aliases ?? [])
            if (isReviewedModel(alias)) available.add(alias);
    }
    return aliases
        .filter((model) => available.has(model))
        .map((model) => {
            const profile = capabilityProfile(model);
            return {
                model,
                // Catalog metadata has not observed an embedding response ID; only a probe can create the complete identity.
                digest: fingerprint(profile),
                family: profile.family,
                identityKind: profile.identityKind,
                discoverySource: 'HOSTED_CATALOG',
                defaultDimensions: profile.defaultDimensions,
                supportedDimensions: profile.supportedDimensions,
                contextTokens: profile.contextTokens,
            };
        });
}

async function batch(
    config: MistralConfiguration,
    model: MistralModel,
    inputs: string[],
    signal: AbortSignal,
    expectedModel?: MistralModel
) {
    const response = parse(
        responseSchema,
        await requestJson(config, 'embeddings', signal, {
            input: inputs,
            model,
            ['encoding_format']: 'float',
        })
    );
    if (
        !isReviewedModel(response.model) ||
        response.data.length !== inputs.length
    )
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    if (expectedModel && response.model !== expectedModel)
        throw new EmbeddingError('MODEL_CHANGED');
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
        if (!Number.isFinite(norm) || norm <= 0)
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
        responseModel: response.model,
    };
}

/** Both synthetic native probes must observe the same reviewed response alias; model listing is not a prerequisite. */
export async function verifyMistralEmbeddingModel(
    config: MistralConfiguration,
    input: VerifyEmbeddingOptions,
    options: RequestOptions = {}
): Promise<MistralModelIdentity> {
    configurationUrl(config);
    const model = supportedModel(input.model);
    if (input.dimensions !== 1024)
        throw new EmbeddingError('DIMENSIONS_UNSUPPORTED');
    if (input.preset !== 'GENERIC')
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    const profile = capabilityProfile(model);
    const signal = operationSignal(options);
    let observed: MistralModel | undefined;
    for (const kind of ['document', 'query'] as const) {
        const text = prepareEmbeddingInput(
            profile,
            kind,
            'Vectorix embedding capability check.',
            { preparation: input.preparation }
        );
        observed = (await batch(config, model, [text], signal, observed))
            .responseModel;
    }
    return capabilityIdentity(model, observed!);
}

async function embed(
    config: MistralConfiguration,
    saved: MistralModelIdentity,
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
    for (let position = 0; position < inputs.length;) {
        const texts: string[] = [];
        let preparedByteBound = 0;
        while (
            position < inputs.length &&
            texts.length < identity.batchPolicy.maxInputs
        ) {
            const text = inputs[position]!;
            const bound =
                Buffer.byteLength(text) +
                identity.batchPolicy.inputTokenReserve;
            if (
                preparedByteBound + bound >
                identity.batchPolicy.maxPreparedInputBytes
            ) {
                if (!texts.length) throw new EmbeddingError('INPUT_TOO_LARGE');
                break;
            }
            preparedByteBound += bound;
            texts.push(text);
            position++;
        }
        const result = await batch(
            config,
            identity.model,
            texts,
            signal,
            identity.responseModel
        );
        vectors.push(...result.vectors);
        requests++;
        estimatedInputTokens += texts.reduce(
            (sum, text) => sum + Math.ceil(Buffer.byteLength(text) / 4),
            0
        );
        providerInputTokens =
            providerInputTokens === null || result.providerInputTokens === null
                ? null
                : providerInputTokens + result.providerInputTokens;
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

/** Embed literal Generic document text with fixed native dimensions and no invented title or retrieval parameters. */
export function embedMistralDocuments(
    config: MistralConfiguration,
    identity: MistralModelIdentity,
    values: EmbeddingDocument[],
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, values, 'document', options);
}
/** Queries share the native text protocol; the saved observed response alias remains mandatory. */
export function embedMistralQuery(
    config: MistralConfiguration,
    identity: MistralModelIdentity,
    text: string,
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, [{ text }], 'query', options);
}
