import * as ollama from './ollama';
import { configurationUrl } from './http';
import {
    canonicalCohereModel,
    discoverCohereModels,
    verifyCohereEmbeddingModel,
    embedCohereDocuments,
    embedCohereQuery,
} from './cohere';
import {
    canonicalVoyageModel,
    discoverVoyageModels,
    verifyVoyageEmbeddingModel,
    embedVoyageDocuments,
    embedVoyageQuery,
} from './voyage';
import {
    EmbeddingError,
    type OllamaConfiguration,
    type CohereConfiguration,
    type VoyageConfiguration,
    type OllamaModelIdentity,
    type CohereModelIdentity,
    type VoyageModelIdentity,
    type EmbeddingConfiguration,
    type ModelIdentity,
    type RequestOptions,
    type VerifyEmbeddingOptions,
    type EmbeddingDocument,
    type EmbeddingOptions,
} from './types';

/** Canonicalization is provider-specific; hosted IDs never receive Ollama's default tag. */
export function canonicalEmbeddingModel(provider: string, model: string) {
    if (provider === 'OLLAMA') return ollama.canonicalOllamaModel(model);
    if (provider === 'COHERE') return canonicalCohereModel(model);
    if (provider === 'VOYAGE') return canonicalVoyageModel(model);
    throw new EmbeddingError('INVALID_CONFIGURATION');
}
/** Ollama/Cohere discovery calls their bound service; Voyage lists a reviewed local catalog without I/O. Neither proves embedding readiness. */
export async function discoverModels(
    config: EmbeddingConfiguration,
    options: RequestOptions = {}
) {
    configurationUrl(config);
    if (config.provider === 'OLLAMA')
        return await ollama.discoverModels(config, options);
    if (config.provider === 'COHERE')
        return await discoverCohereModels(config, options);
    if (config.provider === 'VOYAGE')
        return discoverVoyageModels(config, options);
    throw new EmbeddingError('INVALID_CONFIGURATION');
}
/** Verify a complete resolved provider configuration without reading environment or organization state. */
export function verifyEmbeddingModel(
    config: OllamaConfiguration,
    input: VerifyEmbeddingOptions,
    options?: RequestOptions
): Promise<OllamaModelIdentity>;
export function verifyEmbeddingModel(
    config: CohereConfiguration,
    input: VerifyEmbeddingOptions,
    options?: RequestOptions
): Promise<CohereModelIdentity>;
export function verifyEmbeddingModel(
    config: VoyageConfiguration,
    input: VerifyEmbeddingOptions,
    options?: RequestOptions
): Promise<VoyageModelIdentity>;
export function verifyEmbeddingModel(
    config: EmbeddingConfiguration,
    input: VerifyEmbeddingOptions,
    options?: RequestOptions
): Promise<ModelIdentity>;
export async function verifyEmbeddingModel(
    config: EmbeddingConfiguration,
    input: VerifyEmbeddingOptions,
    options: RequestOptions = {}
) {
    configurationUrl(config);
    if (config.provider === 'OLLAMA')
        return await ollama.verifyEmbeddingModel(config, input, options);
    if (config.provider === 'COHERE')
        return await verifyCohereEmbeddingModel(config, input, options);
    if (config.provider === 'VOYAGE')
        return await verifyVoyageEmbeddingModel(config, input, options);
    throw new EmbeddingError('INVALID_CONFIGURATION');
}
/** Dispatch only when the immutable snapshot belongs to the resolved provider. */
export async function embedDocuments(
    config: EmbeddingConfiguration,
    identity: ModelIdentity,
    values: EmbeddingDocument[],
    options: EmbeddingOptions = {}
) {
    configurationUrl(config);
    if (config.provider === 'OLLAMA' && identity?.provider === 'OLLAMA')
        return await ollama.embedDocuments(config, identity, values, options);
    if (config.provider === 'COHERE' && identity?.provider === 'COHERE')
        return await embedCohereDocuments(config, identity, values, options);
    if (config.provider === 'VOYAGE' && identity?.provider === 'VOYAGE')
        return await embedVoyageDocuments(config, identity, values, options);
    throw new EmbeddingError('MODEL_CHANGED');
}
/** Query and document roles remain distinct in every native provider implementation. */
export async function embedQuery(
    config: EmbeddingConfiguration,
    identity: ModelIdentity,
    text: string,
    options: EmbeddingOptions = {}
) {
    configurationUrl(config);
    if (config.provider === 'OLLAMA' && identity?.provider === 'OLLAMA')
        return await ollama.embedQuery(config, identity, text, options);
    if (config.provider === 'COHERE' && identity?.provider === 'COHERE')
        return await embedCohereQuery(config, identity, text, options);
    if (config.provider === 'VOYAGE' && identity?.provider === 'VOYAGE')
        return await embedVoyageQuery(config, identity, text, options);
    throw new EmbeddingError('MODEL_CHANGED');
}
