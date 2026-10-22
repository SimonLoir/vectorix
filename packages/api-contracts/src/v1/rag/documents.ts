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
export const parserDiagnostic = z.enum([
    'PDF_OCR_UNAVAILABLE',
    'PDF_ENCRYPTED',
    'FILE_INVALID',
    'PARSER_LIMIT',
    'PARSER_TIMEOUT',
    'PARSER_UNAVAILABLE',
]);
export const documentSource = z.object({
    kind: z.enum(['text', 'pdf-page', 'docx-paragraph']),
    index: z.number().int().min(0).max(4999),
    start: z.number().int().min(0),
    end: z.number().int().min(0),
    page: z.number().int().min(1).max(500).optional(),
    paragraph: z.number().int().min(1).max(5000).optional(),
    section: z.number().int().min(1).max(5000).optional(),
    heading: z.string().max(200).optional(),
    part: z
        .enum(['body', 'header', 'footer', 'footnote', 'endnote'])
        .optional(),
    partIndex: z.number().int().min(1).max(2000).optional(),
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
                    diagnostic: parserDiagnostic.nullable().optional(),
                })
                .nullable(),
        })
        .nullable(),
});
export const cleanupDetails = z.object({
    status: z.enum(['PENDING', 'PROCESSING', 'FAILED', 'COMPLETE']),
    reason: z.enum(['REPLACED', 'DELETED']),
    scheduledAt: z.date(),
    attempts: z.number().int(),
    errorCode: z.enum(['STORAGE_UNAVAILABLE', 'CLEANUP_FAILED']).nullable(),
    completedAt: z.date().nullable(),
});
export const documentLifecycle = z.object({
    document,
    deletedAt: z.date().nullable(),
    publishedVersionId: id.nullable(),
    latestVersionId: id.nullable(),
    versions: z.array(
        z.object({
            id,
            version: z.number().int(),
            fileName: z.string(),
            status: documentStatus,
            byteSize: z.number().int(),
            createdAt: z.date(),
            discardedAt: z.date().nullable(),
            task: documentDetails.shape.version.unwrap().shape.task,
            cleanup: cleanupDetails.nullable(),
        })
    ),
    total: z.number().int(),
});
const retentionDays = z.number().int().min(0).max(365);
const reference = z.object({ id }).strict();
export const documentsContract = {
    sourcePreview: oc
        .route({ method: 'GET', path: '/documents/{id}/source-preview' })
        .input(
            z
                .object({
                    id,
                    sourceIndex: z.number().int().min(0).max(4999).default(0),
                    offset: z
                        .number()
                        .int()
                        .min(0)
                        .max(MAX_DOCUMENT_BYTES)
                        .default(0),
                })
                .strict()
        )
        .output(
            z.object({
                format: z.enum(['TEXT', 'MARKDOWN', 'PDF', 'DOCX']),
                version: z.number().int(),
                source: documentSource,
                totalSources: z.number().int().min(1).max(5000),
                text: z.string().max(20_000),
                nextOffset: z.number().int().nullable(),
                totalCharacters: z.number().int(),
                warnings: z
                    .array(
                        z.object({
                            code: z.literal('NO_TEXT'),
                            sourceIndex: z.number().int().min(0).max(4999),
                        })
                    )
                    .max(5000),
            })
        ),
    replace: oc
        .route({ method: 'POST', path: '/documents/{id}/replacements' })
        .input(
            z
                .object({
                    id,
                    expectedVersionId: id,
                    requestId: z.uuid(),
                    file: z.file().min(1).max(MAX_DOCUMENT_BYTES),
                    retentionDays: retentionDays.default(7),
                })
                .strict()
        )
        .output(z.object({ id, versionId: id })),
    delete: oc
        .route({ method: 'DELETE', path: '/documents/{id}' })
        .input(
            z
                .object({
                    id,
                    expectedVersionId: id,
                    retentionDays: retentionDays.default(0),
                })
                .strict()
        )
        .output(success),
    trash: oc
        .route({ method: 'GET', path: '/documents/deleted' })
        .input(page)
        .output(
            z.object({
                items: z.array(document.extend({ deletedAt: z.date() })),
                total: z.number().int(),
            })
        ),
    lifecycle: oc
        .route({ method: 'GET', path: '/documents/{id}/lifecycle' })
        .input(
            z
                .object({
                    id,
                    offset: z.number().int().min(0).default(0),
                    limit: z.number().int().min(1).max(50).default(10),
                })
                .strict()
        )
        .output(documentLifecycle),
    retryCleanup: oc
        .route({
            method: 'POST',
            path: '/documents/{id}/versions/{versionId}/cleanup/retry',
        })
        .input(z.object({ id, versionId: id }).strict())
        .output(success),
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
