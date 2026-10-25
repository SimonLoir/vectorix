import { COHERE_MODELS } from './reviewed-models';
export { COHERE_MODELS } from './reviewed-models';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { requestJson, operationSignal, configurationUrl } from './http';
import { observeEmbeddingBatch } from './batch-observer';
import { prepareEmbeddingInput } from './preparation';
import {
    cohereModelIdentity,
    EmbeddingError,
    type CohereConfiguration,
    type CohereModelIdentity,
    type ModelSummary,
    type RequestOptions,
    type VerifyEmbeddingOptions,
    type EmbeddingDocument,
    type EmbeddingOptions,
    type EmbeddingResult,
} from './types';

type CohereModel = keyof typeof COHERE_MODELS;
const modelName = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const listedModels = z.object({
    models: z
        .array(
            z.object({
                name: z.string().min(1).max(200).nullish(),
                endpoints: z
                    .array(z.string().min(1).max(100))
                    .max(16)
                    .nullish(),
                ['is_deprecated']: z.boolean().nullish(),
            })
        )
        .max(100),
    ['next_page_token']: z.string().max(512).nullish(),
});
const tokens = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const billedTokens = z
    .number()
    .finite()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER);
const embedded = z.object({
    embeddings: z.object({
        float: z
            .array(z.array(z.number().finite()).min(1).max(1536))
            .min(1)
            .max(96),
    }),
    texts: z
        .array(z.string().max(128 * 1024))
        .max(96)
        .nullish(),
    meta: z
        .object({
            tokens: z.object({ ['input_tokens']: tokens.nullish() }).nullish(),
            ['billed_units']: z
                .object({ ['input_tokens']: billedTokens.nullish() })
                .nullish(),
        })
        .nullish(),
});
function parse<T>(schema: z.ZodType<T>, value: unknown) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    return parsed.data;
}
/** Hosted IDs are exact, case-sensitive provider IDs; Ollama's implicit :latest tag is never applied. */
export function canonicalCohereModel(name: string): string {
    if (!modelName.safeParse(name).success)
        throw new EmbeddingError('INVALID_CONFIGURATION');
    return name;
}
function supportedModel(name: string): CohereModel {
    canonicalCohereModel(name);
    if (!Object.hasOwn(COHERE_MODELS, name))
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    return name as CohereModel;
}
function capabilityIdentity(
    model: CohereModel,
    dimensions: number
): CohereModelIdentity {
    const caps = COHERE_MODELS[model];
    if (!(caps.supportedDimensions as readonly number[]).includes(dimensions))
        throw new EmbeddingError('DIMENSIONS_UNSUPPORTED');
    const profile = {
        schemaVersion: 2 as const,
        provider: 'COHERE' as const,
        identityKind: 'CAPABILITY_PROFILE' as const,
        model,
        family: 'cohere-embed' as const,
        contextTokens: caps.contextTokens,
        defaultDimensions: caps.defaultDimensions,
        dimensions,
        supportedDimensions: [...caps.supportedDimensions],
        capabilities: ['embedding', 'search_document', 'search_query'],
        preset: 'GENERIC' as const,
        documentInputType: 'search_document' as const,
        queryInputType: 'search_query' as const,
        embeddingType: 'float' as const,
        truncate: 'NONE' as const,
    };
    return {
        ...profile,
        digest: createHash('sha256')
            .update('vectorix:cohere-capability-profile:v1\n')
            .update(JSON.stringify(profile))
            .digest('hex'),
    };
}
/** Revalidate stored profile semantics locally; this fingerprint cannot attest to hosted provider weights. */
function savedIdentity(value: CohereModelIdentity) {
    const identity = parse(cohereModelIdentity, value);
    if (
        !isDeepStrictEqual(
            identity,
            capabilityIdentity(identity.model, identity.dimensions)
        )
    )
        throw new EmbeddingError('MODEL_CHANGED');
    return identity;
}
async function availableModels(
    config: CohereConfiguration,
    signal: AbortSignal
) {
    const found = new Set<CohereModel>();
    const visited = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < 5; page++) {
        const response = parse(
            listedModels,
            await requestJson(config, 'v1/models', signal, undefined, {
                endpoint: 'embed',
                ['page_size']: '100',
                ...(pageToken ? { ['page_token']: pageToken } : {}),
            })
        );
        for (const model of response.models)
            if (
                model.name &&
                !model.is_deprecated &&
                (!model.endpoints || model.endpoints.includes('embed')) &&
                Object.hasOwn(COHERE_MODELS, model.name)
            )
                found.add(model.name as CohereModel);
        if (!response.next_page_token) return found;
        if (visited.has(response.next_page_token))
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
        visited.add(response.next_page_token);
        pageToken = response.next_page_token;
    }
    throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
}
/** Query the authenticated native catalog, intersect it with reviewed text models, and never claim embedding readiness from listing alone. */
export async function discoverCohereModels(
    config: CohereConfiguration,
    options: RequestOptions = {}
): Promise<ModelSummary[]> {
    const available = await availableModels(config, operationSignal(options));
    return (Object.keys(COHERE_MODELS) as CohereModel[])
        .filter((model) => available.has(model))
        .map((model) => {
            const identity = capabilityIdentity(
                model,
                COHERE_MODELS[model].defaultDimensions
            );
            return {
                model,
                digest: identity.digest,
                family: identity.family,
                identityKind: identity.identityKind,
                discoverySource: 'HOSTED_CATALOG',
                defaultDimensions: identity.defaultDimensions,
                supportedDimensions: identity.supportedDimensions,
                contextTokens: identity.contextTokens,
            };
        });
}
async function batch(
    config: CohereConfiguration,
    identity: CohereModelIdentity,
    inputs: string[],
    kind: 'document' | 'query',
    signal: AbortSignal
) {
    const response = parse(
        embedded,
        await requestJson(config, 'v2/embed', signal, {
            model: identity.model,
            texts: inputs,
            ['input_type']:
                kind === 'document'
                    ? identity.documentInputType
                    : identity.queryInputType,
            ['embedding_types']: [identity.embeddingType],
            truncate: identity.truncate,
            ...(identity.model === 'embed-v4.0'
                ? { ['output_dimension']: identity.dimensions }
                : {}),
        })
    );
    if (
        response.embeddings.float.length !== inputs.length ||
        (response.texts && !isDeepStrictEqual(response.texts, inputs))
    )
        throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    for (const vector of response.embeddings.float) {
        let norm = 0;
        for (const value of vector) {
            const rounded = Math.fround(value);
            if (!Number.isFinite(rounded))
                throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
            norm += rounded * rounded;
        }
        if (
            vector.length !== identity.dimensions ||
            !Number.isFinite(norm) ||
            norm <= 0
        )
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    return response;
}
/** Probe both native retrieval roles at the exact requested dimensions using synthetic, non-organization text. */
export async function verifyCohereEmbeddingModel(
    config: CohereConfiguration,
    input: VerifyEmbeddingOptions,
    options: RequestOptions = {}
): Promise<CohereModelIdentity> {
    configurationUrl(config);
    const model = supportedModel(input.model);
    if (input.preset !== 'GENERIC')
        throw new EmbeddingError('MODEL_UNSUPPORTED');
    const identity = capabilityIdentity(model, input.dimensions);
    const signal = operationSignal(options);
    if (!(await availableModels(config, signal)).has(model))
        throw new EmbeddingError('MODEL_NOT_FOUND');
    for (const kind of ['document', 'query'] as const) {
        const text = prepareEmbeddingInput(
            identity,
            kind,
            'Vectorix embedding capability check.',
            { preparation: input.preparation }
        );
        await batch(config, identity, [text], kind, signal);
    }
    return identity;
}
async function embed(
    config: CohereConfiguration,
    saved: CohereModelIdentity,
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
    let providerInputTokens: number | null = 0,
        billedInputTokens: number | null = 0,
        estimatedInputTokens = 0,
        requests = 0;
    for (let position = 0; position < inputs.length;) {
        const texts: string[] = [];
        let bytes = 0;
        while (position < inputs.length && texts.length < 96) {
            const text = inputs[position]!;
            const size = Buffer.byteLength(JSON.stringify(text));
            if (bytes + size > 1024 * 1024 && texts.length) break;
            texts.push(text);
            bytes += size;
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
            async () => {
                const response = await batch(
                    config,
                    identity,
                    texts,
                    kind,
                    signal
                );
                return {
                    vectors: response.embeddings.float,
                    providerInputTokens:
                        response.meta?.tokens?.input_tokens ?? null,
                    billedInputTokens:
                        response.meta?.billed_units?.input_tokens ?? null,
                };
            }
        );
        vectors.push(...result.vectors);
        requests++;
        estimatedInputTokens += result.usage.estimatedInputTokens;
        const actual = result.usage.providerInputTokens;
        const billed = result.usage.billedInputTokens;
        providerInputTokens =
            actual === null ||
            actual === undefined ||
            providerInputTokens === null
                ? null
                : providerInputTokens + actual;
        billedInputTokens =
            billed === null ||
            billed === undefined ||
            billedInputTokens === null
                ? null
                : billedInputTokens + billed;
        if (
            (providerInputTokens !== null &&
                !Number.isSafeInteger(providerInputTokens)) ||
            (billedInputTokens !== null &&
                (!Number.isFinite(billedInputTokens) ||
                    billedInputTokens > Number.MAX_SAFE_INTEGER))
        )
            throw new EmbeddingError('INVALID_PROVIDER_RESPONSE');
    }
    return {
        vectors,
        usage: {
            providerInputTokens,
            billedInputTokens,
            estimatedInputTokens,
            requests,
        },
    };
}
/** Cohere's retrieval distinction is the native input_type field; no model-name prefixes or title prompts are invented. */
export function embedCohereDocuments(
    config: CohereConfiguration,
    identity: CohereModelIdentity,
    values: EmbeddingDocument[],
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, values, 'document', options);
}
/** A query always uses search_query, even for the same literal text used as a document. */
export function embedCohereQuery(
    config: CohereConfiguration,
    identity: CohereModelIdentity,
    text: string,
    options: EmbeddingOptions = {}
) {
    return embed(config, identity, [{ text }], 'query', options);
}
