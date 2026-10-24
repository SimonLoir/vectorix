import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { formatVectorixApiVersion } from '@repo/api/versioning';
import {
    VECTORIX_CSRF_HEADER,
    VECTORIX_CSRF_VALUE,
} from '@repo/api/transport-security';
import type { ApiVersionDefinition } from './registry';

const openApiGenerator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
});

const RATE_LIMITED_RESPONSE = {
    description:
        'Rate limit exceeded for this organization principal or provider-backed operation. Retry after the number of seconds in Retry-After.',
    headers: {
        'Retry-After': {
            description: 'Seconds until the current rate-limit window ends.',
            schema: { type: 'integer', minimum: 1 },
        },
    },
};
const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch']);

/** Every authenticated operation may answer 429; the public health check is exempt. */
function withRateLimitResponses<T extends { paths?: Record<string, unknown> }>(
    spec: T
): T {
    for (const [path, item] of Object.entries(spec.paths ?? {})) {
        if (path === '/health' || !item || typeof item !== 'object') continue;
        for (const [method, operation] of Object.entries(item)) {
            if (!HTTP_METHODS.has(method) || !operation) continue;
            const responses = ((
                operation as { responses?: Record<string, unknown> }
            ).responses ??= {});
            responses['429'] ??= RATE_LIMITED_RESPONSE;
        }
    }
    return spec;
}

/** Generates one OpenAPI document against the requested public REST prefix. */
export async function generateOpenApiSpec(
    version: ApiVersionDefinition,
    serverUrl: string = version.restPath
): Promise<Record<string, unknown>> {
    const spec = await openApiGenerator.generate(version.contract, {
        info: {
            title: `Vectorix API v${version.major}`,
            version: formatVectorixApiVersion(version),
            description: `Unsafe requests carrying Cookie require a configured trusted Origin or Referer. When both headers are absent, send ${VECTORIX_CSRF_HEADER}: ${VECTORIX_CSRF_VALUE}. The marker never overrides an explicitly rejected origin. API-key and bearer requests without Cookie retain their authentication rules.`,
        },
        servers: [{ url: serverUrl }],
        security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
        components: {
            securitySchemes: {
                ApiKeyAuth: {
                    type: 'apiKey',
                    name: 'x-api-key',
                    in: 'header',
                },
                BearerAuth: {
                    type: 'http',
                    scheme: 'bearer',
                    description:
                        'A personal Vectorix session token. Organization membership and current member permissions are checked for each operation.',
                },
            },
        },
    });

    return {
        ...withRateLimitResponses(spec),
        info: {
            ...spec.info,
            'x-vectorix-api-major': version.major,
            'x-vectorix-api-revision': version.revision,
        },
    };
}
