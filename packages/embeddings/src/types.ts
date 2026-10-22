import { z } from 'zod';

export type OllamaConfiguration = {
    provider: 'OLLAMA';
    endpoint: string;
    apiKey: string | null;
};
export const embeddingPreset = z.enum(['GENERIC', 'EMBEDDING_GEMMA']);
export type EmbeddingPreset = z.infer<typeof embeddingPreset>;
export const modelIdentity = z
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
export type ModelIdentity = z.infer<typeof modelIdentity>;
export type ModelSummary = { model: string; digest: string; family: string };
export type EmbeddingDocument = { text: string; title?: string };
export type EmbeddingUsage = {
    /** Ollama's aggregate prompt_eval_count. Null means at least one batch omitted it. */
    providerInputTokens: number | null;
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
