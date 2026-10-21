import { z } from 'zod';

export const id = z.string().min(1).max(128);
export const empty = z.object({}).strict().default({});
export const page = z
    .object({
        offset: z.number().int().min(0).max(100_000).default(0),
        limit: z.number().int().min(1).max(100).default(25),
        query: z.string().trim().max(200).default(''),
    })
    .strict()
    .default({ offset: 0, limit: 25, query: '' });
export const success = z.object({ success: z.literal(true) });
export const principalPage = z.object({
    items: z.array(z.object({ id, name: z.string() })),
    total: z.number().int(),
});
export const provider = z.enum([
    'S3',
    'OLLAMA',
    'COHERE',
    'VOYAGE',
    'OPENAI',
    'MISTRAL',
]);
export const embeddingProvider = z.enum([
    'OLLAMA',
    'COHERE',
    'VOYAGE',
    'OPENAI',
    'MISTRAL',
]);
export const grantPermissions = z
    .object({
        read: z.boolean(),
        manageDocuments: z.boolean(),
        administer: z.boolean(),
    })
    .strict();
export const collectionScope = z
    .object({
        collectionId: id,
        read: z.boolean(),
        manageDocuments: z.boolean(),
    })
    .strict();
export const collectionScopes = z
    .array(collectionScope)
    .max(100)
    .refine(
        (items) =>
            new Set(items.map((item) => item.collectionId)).size ===
            items.length,
        'Collection scopes must be unique.'
    );
