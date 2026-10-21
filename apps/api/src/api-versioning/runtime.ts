import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { ORPCError, ValidationError } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { experimental_ZodSmartCoercionPlugin as ZodSmartCoercionPlugin } from '@orpc/zod/zod4';
import { logger } from '../lib/logger';
import { API_VERSION_REGISTRY } from './registry';

function logOrpcError(error: unknown) {
    if (error instanceof ORPCError && error.status < 500) return;
    if (error instanceof ORPCError && error.cause instanceof ValidationError) {
        logger.error(
            { issueCount: error.cause.issues.length },
            'oRPC output validation failed'
        );
        return;
    }

    logger.error(error);
}

/** Runtime handlers paired with their immutable major-version definition. */
export const API_VERSION_RUNTIMES = API_VERSION_REGISTRY.map((version) => ({
    version,
    openApiHandler: new OpenAPIHandler(version.router, {
        plugins: [new ZodSmartCoercionPlugin()],
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    logOrpcError(error);
                    throw error;
                }
            },
        ],
    }),
    rpcHandler: new RPCHandler(version.router, {
        interceptors: [
            async (options) => {
                try {
                    return await options.next();
                } catch (error) {
                    logOrpcError(error);
                    throw error;
                }
            },
        ],
    }),
}));

export const CURRENT_API_RUNTIME = API_VERSION_RUNTIMES.find(
    ({ version }) => version.status === 'current'
)!;
