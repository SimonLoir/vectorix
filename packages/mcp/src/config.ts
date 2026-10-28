import { z } from 'zod';

export const collectionId = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[\u0021-\u007E]+$/u);
const requiredValue = z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[^\r\n]+$/u);

export type McpConfiguration = {
    apiUrl: string;
    apiKey: string;
    organizationId: string;
    collectionIds: ReadonlySet<string> | null;
};

/** Read only explicit server configuration; local collection restrictions never grant API access. */
export function readConfiguration(
    environment: Record<string, string | undefined>
): McpConfiguration {
    const apiUrl = requiredValue.parse(environment.VECTORIX_API_URL);
    const url = new URL(apiUrl);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('CONFIGURATION_INVALID');
    const apiKey = requiredValue.parse(environment.VECTORIX_API_KEY);
    const organizationId = collectionId.parse(
        environment.VECTORIX_ORGANIZATION_ID
    );
    const rawCollections = environment.VECTORIX_COLLECTION_IDS;
    const collectionIds =
        rawCollections === undefined
            ? null
            : z
                  .array(collectionId)
                  .min(1)
                  .max(100)
                  .parse(
                      rawCollections.split(',').map((value) => value.trim())
                  );
    return {
        apiUrl,
        apiKey,
        organizationId,
        collectionIds: collectionIds ? new Set(collectionIds) : null,
    };
}
