import {
    createORPCClient,
    type ClientLink,
    type InferClientContext,
} from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { InferContractRouterInputs } from '@orpc/contract';
import type {
    VectorixApiV1Client,
    VectorixApiV1Contract,
} from '@repo/api-contracts/v1';
import {
    clientConfiguration,
    type VectorixClientOptions,
} from './configuration';
import { sanitizeClientFailure, VectorixClientError } from './errors';
import { securedFetch, withDeadline } from './transport';

export type {
    VectorixApiV1Client,
    VectorixApiV1Outputs,
} from '@repo/api-contracts/v1';
export type { VectorixClientOptions } from './configuration';
export {
    VectorixClientError,
    type VectorixClientErrorCode,
    type VectorixServerErrorCode,
} from './errors';
export {
    VECTORIX_SUPPORTED_API_MAJOR,
    VECTORIX_MIN_API_REVISION,
    VECTORIX_DEFAULT_TIMEOUT_MS,
    VECTORIX_MAX_TIMEOUT_MS,
    VECTORIX_MAX_RESPONSE_BYTES,
} from './configuration';
export type VectorixApiV1Inputs =
    InferContractRouterInputs<VectorixApiV1Contract>;
export type RetrievalSearchInput = VectorixApiV1Inputs['retrieval']['search'];
export type RetrievalContextInput = VectorixApiV1Inputs['retrieval']['context'];
export type RetrievalCitationInput =
    VectorixApiV1Inputs['retrieval']['citation'];
export type CollectionListInput =
    VectorixApiV1Inputs['admin']['rag']['collections']['list'];

/**
 * Create the full stable API client. A key never gains session-only operations,
 * collection grants or permissions from this wrapper. Calls are never retried.
 * Each procedure accepts its normal second options argument, including signal.
 */
export function createVectorixClient(
    options: VectorixClientOptions
): VectorixApiV1Client {
    let configuration: ReturnType<typeof clientConfiguration>;
    try {
        configuration = clientConfiguration(options);
    } catch {
        throw new VectorixClientError('INVALID_CONFIGURATION');
    }
    const link = new RPCLink({
        url: configuration.origin + '/rpc/v1',
        fetch: securedFetch(configuration),
    });
    const bounded: ClientLink<InferClientContext<VectorixApiV1Client>> = {
        async call(path, input, callOptions) {
            try {
                return await withDeadline(
                    (signal) =>
                        link.call(path, input, { ...callOptions, signal }),
                    configuration.timeoutMs,
                    callOptions.signal
                );
            } catch (error) {
                throw sanitizeClientFailure(error);
            }
        },
    };
    return createORPCClient<VectorixApiV1Client>(bounded);
}
