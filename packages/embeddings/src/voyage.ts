import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { configurationUrl, operationSignal, requestJson } from './http';
import { prepareEmbeddingInput } from './preparation';
import {
    EmbeddingError,
    voyageModelIdentity,
    type VoyageConfiguration,
    type VoyageModelIdentity,
    type ModelSummary,
    type RequestOptions,
    type VerifyEmbeddingOptions,
    type EmbeddingDocument,
    type EmbeddingOptions,
    type EmbeddingResult,
} from './types';

const dimensions = [256, 512, 1024, 2048] as const;
const commonCapabilities = {
    contextTokens: 32_000,
    defaultDimensions: 1024,
    supportedDimensions: dimensions,
} as const;
/** Reviewed general-purpose text profiles; listing these models does not contact Voyage or verify credentials. */
export const VOYAGE_MODELS = {
    'voyage-4': { ...commonCapabilities, maxBatchTokens: 320_000 },
    'voyage-4-lite': { ...commonCapabilities, maxBatchTokens: 1_000_000 },
    'voyage-4-large': { ...commonCapabilities, maxBatchTokens: 120_000 },
} as const;
type VoyageModel = keyof typeof VOYAGE_MODELS;
const modelName = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const responseSchema = z.object({
    model: modelName,
    data: z
        .array(
            z.object({
                index: z.number().int().min(0).max(999),
                embedding: z.array(z.number().finite()).min(1).max(2048),
            })
        )
        .min(1)
        .max(1000),
    usage: z
        .object({
            ['total_tokens']: z
                .number()
                .int()
                .nonnegative()
                .max(Number.MAX_SAFE_INTEGER)
                .nullish(),
        })
        .nullish(),
});
const ROLE_TOKEN_RESERVE = 64;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return parsed.data;
}

/** Hosted IDs remain exact and case-sensitive; aliases and Ollama default tags are never inferred. */
export function canonicalVoyageModel(name: string): string {
    if (!modelName.safeParse(name).success)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    return name;
}
function supportedModel(name: string): VoyageModel {
    canonicalVoyageModel(name);
    if (!Object.hasOwn(VOYAGE_MODELS, name))
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    return name as VoyageModel;
}
function capabilityIdentity(
    model: VoyageModel,
    size: number
): VoyageModelIdentity {
    if (!(dimensions as readonly number[]).includes(size))
        throw new EmbeddingError('DIMENSIONS_UNSUPPORTED');
    const profile = {
        schemaVersion: 3 as const,
        provider: 'VOYAGE' as const,
        identityKind: 'CAPABILITY_PROFILE' as const,
        model,
        family: 'voyage-4' as const,
        contextTokens: 32_000 as const,
        defaultDimensions: 1024 as const,
        dimensions: size as VoyageModelIdentity['dimensions'],
        supportedDimensions: [...dimensions],
        capabilities: ['embedding', 'document', 'query'],
        preset: 'GENERIC' as const,
        documentInputType: 'document' as const,
        queryInputType: 'query' as const,
        outputDtype: 'float' as const,
        truncation: false as const,
        maxBatchInputs: 1000 as const,
        maxBatchTokens: VOYAGE_MODELS[model].maxBatchTokens,
    };
    return {
        ...profile,
        digest: createHash('sha256')
            .update('vectorix:voyage-capability-profile:v1\n')
            .update(JSON.stringify(profile))
            .digest('hex'),
    };
}
/** Compare the complete persisted native capability contract; the fingerprint is not hosted-weight attestation. */
function savedIdentity(value: VoyageModelIdentity): VoyageModelIdentity {
    const identity = parse(voyageModelIdentity, value);
    if (
        !isDeepStrictEqual(
            identity,
            capabilityIdentity(identity.model, identity.dimensions)
        )
    )
        throw new EmbeddingError('MODEL_CHANGED');
    return identity;
}

/** Voyage has no native model-list endpoint. This bounded local catalog makes no HTTP or credential-readiness claim. */
export function discoverVoyageModels(
    config: VoyageConfiguration,
    options: RequestOptions = {}
): ModelSummary[] {
    configurationUrl(config);
    const signal = operationSignal(options);
    if (signal.aborted) throw new EmbeddingError('PROVIDER_TIMEOUT');
    return (Object.keys(VOYAGE_MODELS) as VoyageModel[]).map((model) => {
        const identity = capabilityIdentity(model, 1024);
        return {
            model,
            digest: identity.digest,
            family: identity.family,
            identityKind: identity.identityKind,
            reviewedCatalog: true,
            defaultDimensions: identity.defaultDimensions,
            supportedDimensions: identity.supportedDimensions,
            contextTokens: identity.contextTokens,
        };
    });
}

async function batch(
    config: VoyageConfiguration,
    identity: VoyageModelIdentity,
    inputs: string[],
    kind: 'document' | 'query',
    signal: AbortSignal
) {
    const response = parse(
        responseSchema,
        await requestJson(config, 'v1/embeddings', signal, {
            input: inputs,
            model: identity.model,
            ['input_type']:
                kind === 'document'
                    ? identity.documentInputType
                    : identity.queryInputType,
            truncation: identity.truncation,
            ['output_dimension']: identity.dimensions,
            ['output_dtype']: identity.outputDtype,
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
    // Count plus unique in-range integer indices establishes a complete permutation.
    return {
        vectors: Array.from({ length: inputs.length }, (_, index) =>
            ordered.get(index)!
        ),
        providerInputTokens: response.usage?.total_tokens ?? null,
    };
}

/** Probe actual document and query vectors at the saved size without sending organization content. */
export async function verifyVoyageEmbeddingModel(
    config: VoyageConfiguration,
    input: VerifyEmbeddingOptions,
    options: RequestOptions = {}
): Promise<VoyageModelIdentity> {
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
        await batch(config, identity, [text], kind, signal);
    }
    return identity;
}

async function embed(
    config: VoyageConfiguration,
    saved: VoyageModelIdentity,
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
    // Native maximum 1000 is further reduced to keep float JSON responses below 8 MiB.
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
            // Prepared UTF8 bytes plus a conservative native role-token allowance:
            // this bounds aggregate admission without claiming tokenizer accuracy.
            const tokens = Buffer.byteLength(text) + ROLE_TOKEN_RESERVE;
            if (
                encodedBytes + bytes > 1024 * 1024 ||
                tokenBound + tokens > identity.maxBatchTokens
            ) {
                if (!texts.length) throw new EmbeddingError('INPUT_TOO_LARGE');
                break;
            }
            encodedBytes += bytes;
            tokenBound += tokens;
            texts.push(text);
            position++;
        }
        const result = await batch(config, identity, texts, kind, signal);
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

/** Native document input_type supplies the retrieval role; application title/prompts are not invented. */
export function embedVoyageDocuments(
    config: VoyageConfiguration,
    identity: VoyageModelIdentity,
    values: EmbeddingDocument[],
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, values, 'document', options);
}

/** Native query input_type is distinct from document input_type for the same literal text. */
export function embedVoyageQuery(
    config: VoyageConfiguration,
    identity: VoyageModelIdentity,
    text: string,
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, [{ text }], 'query', options);
}
