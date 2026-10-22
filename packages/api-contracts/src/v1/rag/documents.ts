import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id, page, success } from './common';

export const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
export const documentStatus = z.enum([
    'PENDING',
    'PROCESSING',
    'READY',
    'FAILED',
    'DELETED',
]);
export const ingestionError = z.enum([
    'UPLOAD_INCOMPLETE',
    'STORAGE_UNAVAILABLE',
    'TEXT_INVALID',
    'TEXT_EMPTY',
    'ACCESS_REVOKED',
    'PROCESSING_FAILED',
]);
export const document = z.object({
    id,
    name: z.string(),
    status: documentStatus,
    createdAt: z.date(),
    updatedAt: z.date(),
});
export const documentDetails = z.object({
    document,
    canManage: z.boolean(),
    version: z
        .object({
            id,
            version: z.number().int(),
            status: documentStatus,
            byteSize: z.number().int(),
            mediaType: z.string(),
            createdAt: z.date(),
            stored: z.boolean(),
            retryable: z.boolean(),
            previewAvailable: z.boolean(),
            task: z
                .object({
                    status: z.enum([
                        'UPLOADING',
                        'PENDING',
                        'PROCESSING',
                        'READY',
                        'FAILED',
                    ]),
                    attempts: z.number().int(),
                    errorCode: ingestionError.nullable(),
                })
                .nullable(),
        })
        .nullable(),
});
const reference = z.object({ id }).strict();
export const documentsContract = {
    list: oc
        .route({ method: 'GET', path: '/documents' })
        .input(page)
        .output(
            z.object({ items: z.array(document), total: z.number().int() })
        ),
    get: oc
        .route({ method: 'GET', path: '/documents/{id}' })
        .input(reference)
        .output(document),
    details: oc
        .route({ method: 'GET', path: '/documents/{id}/details' })
        .input(reference)
        .output(documentDetails),
    upload: oc
        .route({ method: 'POST', path: '/documents/uploads' })
        .input(
            z
                .object({
                    requestId: z.uuid(),
                    file: z.file().min(1).max(MAX_DOCUMENT_BYTES),
                })
                .strict()
        )
        .output(z.object({ id, versionId: id })),
    retry: oc
        .route({ method: 'POST', path: '/documents/{id}/retry' })
        .input(reference)
        .output(success),
    preview: oc
        .route({ method: 'GET', path: '/documents/{id}/preview' })
        .input(
            reference.extend({
                offset: z
                    .number()
                    .int()
                    .min(0)
                    .max(MAX_DOCUMENT_BYTES)
                    .default(0),
            })
        )
        .output(
            z.object({
                text: z.string(),
                nextOffset: z.number().int().nullable(),
                totalCharacters: z.number().int(),
                version: z.number().int(),
            })
        ),
    download: oc
        .route({ method: 'GET', path: '/documents/{id}/original' })
        .input(reference)
        .output(z.file()),
    collectionCandidates: oc
        .route({ method: 'GET', path: '/documents/{id}/collections' })
        .input(page.unwrap().extend({ id }))
        .output(
            z.object({
                items: z.array(
                    z.object({ id, name: z.string(), attached: z.boolean() })
                ),
                total: z.number().int(),
            })
        ),
    setCollection: oc
        .route({
            method: 'PUT',
            path: '/documents/{id}/collections/{collectionId}',
        })
        .input(
            z.object({ id, collectionId: id, attached: z.boolean() }).strict()
        )
        .output(success),
};
