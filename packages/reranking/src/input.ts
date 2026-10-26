import { RERANKING_LIMITS, listRerankingModels } from './models';
import {
    RerankingError,
    type RerankingInput,
    type RerankingInputStatistics,
    type RerankingProvider,
} from './types';

/** Validate and snapshot all texts before building the exact native body. No truncation is applied. */
export function prepareRerankingInput(
    provider: RerankingProvider,
    input: RerankingInput
) {
    if (provider !== 'COHERE' && provider !== 'VOYAGE')
        throw new RerankingError('INVALID_CONFIGURATION');
    if (
        !input ||
        !listRerankingModels(provider).some((model) => model.id === input.model)
    )
        throw new RerankingError('MODEL_UNSUPPORTED');
    if (
        typeof input.query !== 'string' ||
        input.query.length === 0 ||
        input.query.length > RERANKING_LIMITS.queryBytes ||
        !Array.isArray(input.documents) ||
        input.documents.length === 0 ||
        input.documents.length > RERANKING_LIMITS.documents
    )
        throw new RerankingError('INPUT_TOO_LARGE');
    const model = input.model;
    const encoder = new TextEncoder();
    const queryBytes = encoder.encode(input.query).byteLength;
    if (queryBytes > RERANKING_LIMITS.queryBytes)
        throw new RerankingError('INPUT_TOO_LARGE');
    let preparedInputBytes = queryBytes * input.documents.length;
    const documents: string[] = [];
    for (const document of input.documents) {
        if (
            typeof document !== 'string' ||
            document.length > RERANKING_LIMITS.documentBytes
        )
            throw new RerankingError('INPUT_TOO_LARGE');
        const bytes = encoder.encode(document).byteLength;
        preparedInputBytes += bytes;
        if (
            bytes > RERANKING_LIMITS.documentBytes ||
            preparedInputBytes > RERANKING_LIMITS.repeatedInputBytes
        )
            throw new RerankingError('INPUT_TOO_LARGE');
        documents.push(document);
    }
    const body =
        provider === 'COHERE'
            ? {
                  model,
                  query: input.query,
                  documents,
                  ['top_n']: documents.length,
                  ['max_tokens_per_doc']: 24_000,
              }
            : {
                  model,
                  query: input.query,
                  documents,
                  ['top_k']: documents.length,
                  ['return_documents']: false,
                  truncation: false,
              };
    const encoded = JSON.stringify(body);
    const serializedRequestBytes = encoder.encode(encoded).byteLength;
    if (serializedRequestBytes > RERANKING_LIMITS.requestBytes)
        throw new RerankingError('INPUT_TOO_LARGE');
    return {
        model,
        encoded,
        statistics: {
            candidateCount: documents.length,
            preparedInputBytes,
            serializedRequestBytes,
        },
    };
}

/** All pure input and exact serialized-body checks run before a caller admits provider cost. */
export function validateRerankingInput(
    provider: RerankingProvider,
    input: RerankingInput
): RerankingInputStatistics {
    return prepareRerankingInput(provider, input).statistics;
}
