type Connection = Readonly<{
    apiUrl: string;
    organizationId: string;
    collectionId: string;
}>;

/** Quote every deployment value as a literal; templates never read process secrets or issue requests. */
export function sdkTemplate(connection: Connection, question: string) {
    const collectionId = JSON.stringify(connection.collectionId);
    return `import { createVectorixClient } from '@vectorix/client';

const client = createVectorixClient({
    apiUrl: ${JSON.stringify(connection.apiUrl)},
    apiKey: process.env.VECTORIX_API_KEY!,
    organizationId: ${JSON.stringify(connection.organizationId)},
});

const results = await client.retrieval.search({
    collectionId: ${collectionId},
    query: ${JSON.stringify(question)},
    strategy: 'HYBRID',
    topK: 5,
    filters: {},
});

const hit = results.results[0];
if (hit) {
    const context = await client.retrieval.context({
        collectionId: ${collectionId},
        receipt: hit.source.receipt,
        before: 1,
        after: 1,
    });
    const citation = await client.retrieval.citation({
        collectionId: ${collectionId},
        receipt: hit.source.receipt,
    });
}`;
}

/** The local stdio template contains a key placeholder and only the chosen collection allowlist. */
export function mcpTemplate(connection: Connection) {
    return JSON.stringify(
        {
            mcpServers: {
                vectorix: {
                    command: 'node',
                    args: ['/absolute/path/to/vectorix-mcp/dist/cli.mjs'],
                    env: {
                        VECTORIX_API_URL: connection.apiUrl,
                        VECTORIX_API_KEY: 'YOUR_VECTORIX_API_KEY',
                        VECTORIX_ORGANIZATION_ID: connection.organizationId,
                        VECTORIX_COLLECTION_IDS: connection.collectionId,
                    },
                },
            },
        },
        null,
        2
    );
}
