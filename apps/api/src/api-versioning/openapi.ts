import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { formatVectorixApiVersion } from '@repo/api/versioning';
import type { ApiVersionDefinition } from './registry';

const openApiGenerator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
});

/** Generates one OpenAPI document against the requested public REST prefix. */
export async function generateOpenApiSpec(
    version: ApiVersionDefinition,
    serverUrl: string = version.restPath
): Promise<Record<string, unknown>> {
    const spec = await openApiGenerator.generate(version.contract, {
        info: {
            title: `Vectorix API v${version.major}`,
            version: formatVectorixApiVersion(version),
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
        ...spec,
        info: {
            ...spec.info,
            'x-vectorix-api-major': version.major,
            'x-vectorix-api-revision': version.revision,
        },
    };
}
