import {
    isRichDocument,
    encodeStructuredExtraction,
    DocumentParserError,
    type RichDocumentParser,
} from '@repo/documents';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@repo/db';
import { getMemberPermissions } from '@repo/auth/permissions/resolve';
import { permits } from '@repo/auth/permissions';
import {
    headObject,
    readObject,
    putObject,
    deleteObject,
    StorageError,
} from '@repo/storage';
import { MAX_DOCUMENT_BYTES } from '@repo/api-contracts/v1/rag/documents';
import { boundStorage, contentHash } from './storage';
import { libraryWrite } from './access';
import { extractText, TextExtractionError } from './extract';
import {
    ingestionMayWrite,
    publishExtraction,
    recordIngestionFailure,
} from './ingestion-state';
import { reconcileUnpublishedWrite } from './retention';

const LEASE_MS = 180_000;
/** PostgreSQL owns claims and retries; Redis messages contain no document content or secrets. */
export async function processDocumentIngestions(
    db: PrismaClient,
    parser?: RichDocumentParser
) {
    const now = new Date();
    const eligible = {
        availableAt: { lte: now },
        OR: [
            { status: 'PENDING' as const },
            {
                status: { in: ['UPLOADING' as const, 'PROCESSING' as const] },
                leasedUntil: { lte: now },
            },
        ],
    };
    const tasks = await db.documentIngestion.findMany({
        where: eligible,
        orderBy: [{ availableAt: 'asc' }, { versionId: 'asc' }],
        take: 10,
        select: { versionId: true, status: true },
    });
    for (const task of tasks) {
        const token = randomUUID();
        const claimed = await db.documentIngestion.updateMany({
            where: {
                ...eligible,
                versionId: task.versionId,
                status: task.status,
            },
            data: {
                status:
                    task.status === 'UPLOADING' ? 'UPLOADING' : 'PROCESSING',
                leaseToken: token,
                leasedUntil: new Date(Date.now() + LEASE_MS),
                attempts: { increment: 1 },
            },
        });
        if (claimed.count)
            await processClaim(db, task.versionId, token, parser);
    }
}

/** Both object writes and publication recheck authority; a rejected late write is queued for reconciliation. */
async function processClaim(
    db: PrismaClient,
    versionId: string,
    token: string,
    parser?: RichDocumentParser
) {
    const task = await db.documentIngestion.findUniqueOrThrow({
        where: { versionId },
        include: {
            version: {
                include: {
                    document: {
                        include: {
                            organization: { select: { isActive: true } },
                        },
                    },
                },
            },
        },
    });
    const version = task.version;
    let wrote = false,
        published = false;
    try {
        const membership = await getMemberPermissions(
            task.organizationId,
            task.requestedBy,
            db
        );
        if (
            !version.document.organization.isActive ||
            version.document.deletedAt ||
            !membership ||
            !permits(membership.permissions, libraryWrite)
        )
            throw new TextExtractionError('ACCESS_REVOKED');
        if (!(await ingestionMayWrite(db, versionId, token))) return;
        const config = await boundStorage(
            db,
            task.organizationId,
            version.storageLocationId
        );
        if (!version.storedAt) {
            const object = await headObject(config, version.objectKey);
            if (
                !object ||
                object.byteSize !== Number(version.byteSize) ||
                object.sha256 !== version.sha256
            ) {
                if (object) await deleteObject(config, version.objectKey);
                await recordIngestionFailure(db, {
                    versionId,
                    token,
                    code: 'UPLOAD_INCOMPLETE',
                    terminal: true,
                    delay: new Date(),
                    discard: true,
                });
                return;
            }
            const recovered = await db.documentIngestion.updateMany({
                where: {
                    versionId,
                    leaseToken: token,
                    leasedUntil: { gt: new Date() },
                },
                data: { status: 'PROCESSING' },
            });
            if (!recovered.count) return;
            await db.documentVersion.updateMany({
                where: { id: versionId, document: { deletedAt: null } },
                data: { storedAt: new Date() },
            });
        }
        const original = await readObject(
            config,
            version.objectKey,
            MAX_DOCUMENT_BYTES
        );
        if (contentHash(original) !== version.sha256)
            throw new TextExtractionError('UPLOAD_INCOMPLETE');
        const rich = isRichDocument(version.mediaType);
        let bytes: Uint8Array, extractorVersion: string;
        if (rich) {
            if (!parser) throw new DocumentParserError('PARSER_UNAVAILABLE');
            const result = await parser(original, version.mediaType);
            bytes = encodeStructuredExtraction(result);
            extractorVersion =
                result.format === 'PDF'
                    ? 'pdf-structured-v1'
                    : 'docx-structured-v1';
        } else {
            bytes = extractText(original, version.sha256);
            extractorVersion = 'utf8-text-v1';
        }
        if (bytes.byteLength > Number(task.reservedBytes))
            throw new DocumentParserError('PARSER_LIMIT');
        const key = `${task.organizationId}/${version.documentId}/${versionId}/${rich ? 'extraction.json' : 'text.txt'}`;
        if (!(await ingestionMayWrite(db, versionId, token))) return;
        // Even a failed response may represent a completed remote PUT.
        wrote = true;
        await putObject(
            config,
            key,
            bytes,
            contentHash(bytes),
            rich
                ? 'application/json; charset=utf-8'
                : 'text/plain; charset=utf-8'
        );
        published = await publishExtraction(db, {
            versionId,
            token,
            key,
            byteSize: bytes.byteLength,
            extractorVersion,
        });
        if (!published)
            await recordIngestionFailure(db, {
                versionId,
                token,
                code: 'ACCESS_REVOKED',
                terminal: true,
                delay: new Date(),
            });
    } catch (error) {
        const code =
            error instanceof TextExtractionError ||
            error instanceof DocumentParserError
                ? error.code
                : error instanceof StorageError
                  ? 'STORAGE_UNAVAILABLE'
                  : 'PROCESSING_FAILED';
        await recordIngestionFailure(db, {
            versionId,
            token,
            code,
            terminal:
                error instanceof TextExtractionError ||
                (error instanceof DocumentParserError &&
                    error.code !== 'PARSER_UNAVAILABLE') ||
                task.attempts >= 5,
            delay: new Date(
                Date.now() + Math.min(300_000, 10_000 * 2 ** task.attempts)
            ),
        });
    } finally {
        if (wrote && !published) await reconcileUnpublishedWrite(db, versionId);
    }
}
