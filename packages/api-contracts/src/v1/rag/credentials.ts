import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id, page, provider, success } from './common';

const endpoint = z
    .url()
    .max(2048)
    .refine((value) => {
        const url = new URL(value);
        return (
            ['https:', 'http:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
        );
    }, 'Use an HTTP(S) endpoint without embedded credentials, query parameters, or fragments.');
const secret = z
    .string()
    .min(1)
    .max(8192)
    .refine(
        (value) => value !== '********',
        'Supply a real secret; omit it to preserve the current value.'
    );
const s3 = z
    .object({
        provider: z.literal('S3'),
        endpoint,
        region: z.string().min(1).max(64),
        bucket: z
            .string()
            .min(3)
            .max(63)
            .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
        forcePathStyle: z.boolean(),
        accessKeyId: secret,
        secretAccessKey: secret,
    })
    .strict();
const ollama = z
    .object({
        provider: z.literal('OLLAMA'),
        endpoint,
        apiKey: secret.nullable(),
    })
    .strict();
const cohere = z
    .object({ provider: z.literal('COHERE'), endpoint, apiKey: secret })
    .strict();
const voyage = z
    .object({ provider: z.literal('VOYAGE'), endpoint, apiKey: secret })
    .strict();
export const credentialData = z.discriminatedUnion('provider', [
    s3,
    ollama,
    cohere,
    voyage,
]);
export const credentialUpdateData = z.discriminatedUnion('provider', [
    s3.extend({
        accessKeyId: secret.optional(),
        secretAccessKey: secret.optional(),
    }),
    ollama.extend({ apiKey: secret.nullable().optional() }),
    cohere.extend({ apiKey: secret.optional() }),
    voyage.extend({ apiKey: secret.optional() }),
]);
const masked = z.literal('********');
export const credentialView = z.object({
    id,
    name: z.string(),
    provider,
    revision: z.number().int(),
    active: z.boolean(),
    createdAt: z.date(),
    updatedAt: z.date(),
    data: z.discriminatedUnion('provider', [
        s3.extend({ accessKeyId: masked, secretAccessKey: masked }),
        ollama.extend({ apiKey: masked.nullable() }),
        cohere.extend({ apiKey: masked }),
        voyage.extend({ apiKey: masked }),
    ]),
});
export const credentialsContract = {
    list: oc
        .route({ method: 'GET', path: '/credentials' })
        .input(page)
        .output(
            z.object({
                items: z.array(credentialView),
                total: z.number().int(),
            })
        ),
    create: oc
        .route({ method: 'POST', path: '/credentials' })
        .input(
            z
                .object({
                    name: z.string().trim().min(1).max(100),
                    data: credentialData,
                    activate: z.boolean().default(true),
                })
                .strict()
        )
        .output(credentialView),
    update: oc
        .route({ method: 'PUT', path: '/credentials/{id}' })
        .input(
            z
                .object({
                    id,
                    expectedRevision: z.number().int().positive(),
                    name: z.string().trim().min(1).max(100),
                    data: credentialUpdateData,
                })
                .strict()
        )
        .output(credentialView),
    activate: oc
        .route({ method: 'PUT', path: '/credentials/{id}/active' })
        .input(z.object({ id }).strict())
        .output(success),
    delete: oc
        .route({ method: 'DELETE', path: '/credentials/{id}' })
        .input(
            z
                .object({ id, expectedRevision: z.number().int().positive() })
                .strict()
        )
        .output(success),
};
