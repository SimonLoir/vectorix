import { z } from 'zod';

export type OllamaConfiguration = {
    provider: 'OLLAMA';
    endpoint: string;
    apiKey: string | null;
};
export type CohereConfiguration = {
    provider: 'COHERE';
    endpoint: string;
    apiKey: string;
};
export type VoyageConfiguration = {
    provider: 'VOYAGE';
    endpoint: string;
    apiKey: string;
};
export type OpenAIConfiguration = {
    provider: 'OPENAI';
    /** Complete API base, including any approved prefix and normally /v1. */
    endpoint: string;
    apiKey: string;
};
export type MistralConfiguration = {
    provider: 'MISTRAL';
    /** Complete API base, normally /v1, preserving an approved proxy prefix. */
    endpoint: string;
    apiKey: string;
};
export type EmbeddingConfiguration =
    | OllamaConfiguration
    | CohereConfiguration
    | VoyageConfiguration
    | OpenAIConfiguration
    | MistralConfiguration;
export type EmbeddingProvider = EmbeddingConfiguration['provider'];
export type EmbeddingIdentityKind = 'WEIGHTS_DIGEST' | 'CAPABILITY_PROFILE';
export type EmbeddingDiscoverySource = 'LOCAL_RUNTIME' | 'HOSTED_CATALOG';
export const embeddingPreset = z.enum(['GENERIC', 'EMBEDDING_GEMMA']);
export type EmbeddingPreset = z.infer<typeof embeddingPreset>;
/** Existing persisted Ollama generations retain their original schema and digest semantics. */
export const ollamaModelIdentity = z
    .object({
        schemaVersion: z.literal(1),
        provider: z.literal('OLLAMA'),
        model: z.string().min(1).max(200),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        family: z.string().min(1).max(100),
        architecture: z.string().regex(/^[a-zA-Z0-9_]{1,100}$/),
        contextTokens: z.number().int().min(64).max(1_048_576),
        defaultDimensions: z.number().int().min(1).max(4096),
        dimensions: z.number().int().min(1).max(4096),
        supportedDimensions: z
            .array(z.number().int().min(1).max(4096))
            .min(1)
            .max(8),
        capabilities: z.array(z.string().min(1).max(100)).max(32),
        preset: embeddingPreset,
    })
    .refine((value) => value.supportedDimensions.includes(value.dimensions), {
        message: 'Unsupported embedding dimensions.',
    });
export type OllamaModelIdentity = z.infer<typeof ollamaModelIdentity>;
/** A hosted provider exposes a named capability profile, not a verifiable weights manifest. */
export const cohereModelIdentity = z
    .object({
        schemaVersion: z.literal(2),
        provider: z.literal('COHERE'),
        identityKind: z.literal('CAPABILITY_PROFILE'),
        model: z.enum([
            'embed-v4.0',
            'embed-english-v3.0',
            'embed-multilingual-v3.0',
        ]),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        family: z.literal('cohere-embed'),
        contextTokens: z.number().int().min(64).max(128_000),
        defaultDimensions: z.number().int().min(1).max(1536),
        dimensions: z.number().int().min(1).max(1536),
        supportedDimensions: z
            .array(z.number().int().min(1).max(1536))
            .min(1)
            .max(4),
        capabilities: z.array(z.string().min(1).max(100)).max(32),
        preset: z.literal('GENERIC'),
        documentInputType: z.literal('search_document'),
        queryInputType: z.literal('search_query'),
        embeddingType: z.literal('float'),
        truncate: z.literal('NONE'),
    })
    .strict()
    .refine((value) => value.supportedDimensions.includes(value.dimensions), {
        message: 'Unsupported embedding dimensions.',
    });
export type CohereModelIdentity = z.infer<typeof cohereModelIdentity>;
/** Voyage's reviewed hosted capabilities are versioned independently of earlier provider snapshots. */
export const voyageModelIdentity = z
    .object({
        schemaVersion: z.literal(3),
        provider: z.literal('VOYAGE'),
        identityKind: z.literal('CAPABILITY_PROFILE'),
        model: z.enum(['voyage-4', 'voyage-4-lite', 'voyage-4-large']),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        family: z.literal('voyage-4'),
        contextTokens: z.literal(32_000),
        defaultDimensions: z.literal(1024),
        dimensions: z.union([
            z.literal(256),
            z.literal(512),
            z.literal(1024),
            z.literal(2048),
        ]),
        supportedDimensions: z.array(z.number().int().positive()).length(4),
        capabilities: z.array(z.string().min(1).max(100)).max(32),
        preset: z.literal('GENERIC'),
        documentInputType: z.literal('document'),
        queryInputType: z.literal('query'),
        outputDtype: z.literal('float'),
        truncation: z.literal(false),
        maxBatchInputs: z.literal(1000),
        maxBatchTokens: z.union([
            z.literal(120_000),
            z.literal(320_000),
            z.literal(1_000_000),
        ]),
    })
    .strict()
    .refine((value) => value.supportedDimensions.includes(value.dimensions), {
        message: 'Unsupported embedding dimensions.',
    });
export type VoyageModelIdentity = z.infer<typeof voyageModelIdentity>;
/** Reviewed integer shortening policy; selected dimensions still require a native probe. */
export const dimensionCapability = z
    .object({
        kind: z.literal('RANGE'),
        minimum: z.literal(1),
        maximum: z.union([z.literal(1536), z.literal(3072)]),
        step: z.literal(1),
    })
    .strict();
export type DimensionCapability = z.infer<typeof dimensionCapability>;
/** OpenAI uses a continuous integer range, not an invented exhaustive finite dimension list. */
export const openAIModelIdentity = z
    .object({
        schemaVersion: z.literal(4),
        provider: z.literal('OPENAI'),
        identityKind: z.literal('CAPABILITY_PROFILE'),
        model: z.enum(['text-embedding-3-small', 'text-embedding-3-large']),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        family: z.literal('openai-embedding-3'),
        contextTokens: z.literal(8192),
        defaultDimensions: z.union([z.literal(1536), z.literal(3072)]),
        dimensions: z.number().int().min(1).max(3072),
        dimensionCapability,
        // Compatibility hint containing the exact selected/probed size, not every allowed integer.
        supportedDimensions: z
            .array(z.number().int().min(1).max(3072))
            .length(1),
        capabilities: z.array(z.string().min(1).max(100)).max(32),
        preset: z.literal('GENERIC'),
        retrievalRoles: z.literal('SHARED_INPUT'),
        encodingFormat: z.literal('float'),
        truncation: z.literal('UNSUPPORTED'),
        maxBatchInputs: z.literal(2048),
        maxBatchTokens: z.literal(300_000),
    })
    .strict()
    .refine(
        (value) =>
            value.supportedDimensions[0] === value.dimensions &&
            value.dimensions <= value.dimensionCapability.maximum,
        { message: 'Unsupported embedding dimensions.' }
    );
export type OpenAIModelIdentity = z.infer<typeof openAIModelIdentity>;
/** Fixed-dimension Mistral profile with a stable observed native ID within one explicitly reviewed alias pair. */
export const mistralModelIdentity = z
    .object({
        schemaVersion: z.literal(5),
        provider: z.literal('MISTRAL'),
        identityKind: z.literal('CAPABILITY_PROFILE'),
        model: z.enum(['mistral-embed', 'mistral-embed-2312']),
        responseModel: z.enum(['mistral-embed', 'mistral-embed-2312']),
        equivalentModels: z.tuple([
            z.literal('mistral-embed'),
            z.literal('mistral-embed-2312'),
        ]),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        family: z.literal('mistral-embed'),
        contextTokens: z.literal(8000),
        defaultDimensions: z.literal(1024),
        dimensions: z.literal(1024),
        supportedDimensions: z.array(z.literal(1024)).length(1),
        capabilities: z.array(z.string().min(1).max(100)).max(32),
        preset: z.literal('GENERIC'),
        retrievalRoles: z.literal('SHARED_INPUT'),
        encodingFormat: z.literal('float'),
        truncation: z.literal('UNSUPPORTED'),
        batchPolicy: z
            .object({
                maxInputs: z.literal(64),
                maxPreparedInputBytes: z.literal(16_000),
                inputTokenReserve: z.literal(32),
            })
            .strict(),
    })
    .strict();
export type MistralModelIdentity = z.infer<typeof mistralModelIdentity>;
export const modelIdentity = z.union([
    ollamaModelIdentity,
    cohereModelIdentity,
    voyageModelIdentity,
    openAIModelIdentity,
    mistralModelIdentity,
]);
export type ModelIdentity = z.infer<typeof modelIdentity>;
export type ModelSummary = {
    model: string;
    digest: string;
    family: string;
    identityKind?: EmbeddingIdentityKind;
    discoverySource?: EmbeddingDiscoverySource;
    defaultDimensions?: number;
    supportedDimensions?: number[];
    dimensionCapability?: DimensionCapability;
    contextTokens?: number;
    /** Local supported catalog only; it does not claim a provider listing or credential readiness. */
    reviewedCatalog?: boolean;
};
/** Legacy schemaVersion:1 has no kind field; its digest remains the native Ollama weights manifest. */
export function embeddingIdentityKind(
    identity: ModelIdentity
): EmbeddingIdentityKind {
    return identity.provider === 'OLLAMA'
        ? 'WEIGHTS_DIGEST'
        : identity.identityKind;
}
export type EmbeddingDocument = { text: string; title?: string };
export type EmbeddingUsage = {
    /** Provider-reported model input tokens. Null means at least one batch omitted them. */
    providerInputTokens: number | null;
    /** Separately reported billed input tokens; never substituted for model/tokenizer usage. */
    billedInputTokens?: number | null;
    /** Explicit estimate, never represented as provider billing or exact tokens. */
    estimatedInputTokens: number;
    /** Successful embedding requests, excluding manifest checks and failed HTTP attempts. */
    requests: number;
};
export type EmbeddingResult = { vectors: number[][]; usage: EmbeddingUsage };
export type RequestOptions = { signal?: AbortSignal; timeoutMs?: number };
export type EmbeddingOptions = RequestOptions & { preparation?: string };
export type VerifyEmbeddingOptions = {
    model: string;
    dimensions: number;
    preset: EmbeddingPreset;
    preparation?: string;
};
export type EmbeddingErrorCode =
    | 'INVALID_CONFIGURATION'
    | 'PROVIDER_UNAVAILABLE'
    | 'PROVIDER_TIMEOUT'
    | 'PROVIDER_REJECTED'
    | 'INVALID_PROVIDER_RESPONSE'
    | 'MODEL_NOT_FOUND'
    | 'MODEL_UNSUPPORTED'
    | 'MODEL_CHANGED'
    | 'DIMENSIONS_UNSUPPORTED'
    | 'INPUT_TOO_LARGE';
/** Safe domain errors never retain a URL, credential, provider body, or original error. */
export class EmbeddingError extends Error {
    constructor(public readonly code: EmbeddingErrorCode) {
        super(`Embedding operation failed (${code}).`);
        this.name = 'EmbeddingError';
    }
}
