import { OpenAPIHandler } from '@orpc/openapi/fetch';
import type { AnyRouter, InferRouterInitialContext } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { ResponseHeadersPlugin } from '@orpc/server/plugins';
import { experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin } from '@orpc/zod/zod4';
import {
    normalizeApiError,
    observeApiError,
    type ApiErrorLogger,
    type ApiErrorMetadata,
} from './error-observation';

type ApiRuntimeDefinition = Readonly<{ major: number; router: AnyRouter }>;

/**
 * Production and isolated HTTP tests use the same procedure error boundary.
 * Client interceptors wrap authorization, handlers and output validation once;
 * matcher/codec failures retain oRPC's sanitized defaults without observation.
 * Metadata comes from the registry/factory, never a URL, body or header.
 */
export function createApiVersionRuntime<TVersion extends ApiRuntimeDefinition>(
    version: TVersion
) {
    type RuntimeContext = InferRouterInitialContext<TVersion['router']> & {
        logger: ApiErrorLogger;
    };
    const interceptError =
        (metadata: ApiErrorMetadata) =>
        async (options: {
            context: { logger: ApiErrorLogger };
            next: () => Promise<unknown>;
        }) => {
            try {
                return await options.next();
            } catch (error) {
                observeApiError(error, options.context.logger, metadata);
                throw normalizeApiError(error);
            }
        };

    return {
        version,
        openApiHandler: new OpenAPIHandler<RuntimeContext>(version.router, {
            plugins: [
                new ZodSmartCoercionPlugin(),
                new ResponseHeadersPlugin(),
            ],
            clientInterceptors: [
                interceptError({ transport: 'REST', major: version.major }),
            ],
        }),
        rpcHandler: new RPCHandler<RuntimeContext>(version.router, {
            plugins: [new ResponseHeadersPlugin()],
            clientInterceptors: [
                interceptError({ transport: 'RPC', major: version.major }),
            ],
        }),
    };
}
