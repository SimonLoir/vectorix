import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { processDocumentIngestions } from '@routers/rag/ingestion';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { z } from 'zod';
import { app } from './app';
import {
    DEFAULT_REQUEST_BODY_BYTES,
    DOCUMENT_REQUEST_BODY_BYTES,
} from './http/request-body-limit';

type Fixture = {
    organizationId: string;
    owner: {
        headers(extra?: Record<string, string>): Record<string, string>;
        client(extra?: Record<string, string>): VectorixApiV1Client;
    };
};
const uploadedDocument = z.object({ id: z.string(), versionId: z.string() });

/** Verifies global admission and all binary contract exceptions against disposable PostgreSQL and RustFS. */
export async function requestBodyIntegrationTests(t: TestContext, f: Fixture) {
    assert.ok(
        process.env.VECTORIX_DEFAULT_S3_ENDPOINT,
        'Use pnpm test:catalog for isolated private storage.'
    );
    const run = randomUUID();
    const documents = new Map<string, string>();
    const rag = f.owner.client().admin.rag;
    const smallFile = () =>
        new File(
            [new Uint8Array(2 * 1024 * 1024).fill(65)],
            `body-${run}.txt`,
            { type: 'text/plain' }
        );
    const snapshot = async () => ({
        documents: await prisma.document.count({
            where: { organizationId: f.organizationId },
        }),
        versions: await prisma.documentVersion.count({
            where: { organizationId: f.organizationId },
        }),
        tasks: await prisma.documentIngestion.count({
            where: { organizationId: f.organizationId },
        }),
        users: await prisma.user.count(),
        sessions: await prisma.session.count(),
        verifications: await prisma.verification.count(),
    });
    async function restUpload(
        file: File,
        replacement?: { id: string; versionId: string }
    ) {
        const form = new FormData();
        form.set('requestId', randomUUID());
        form.set('file', file);
        if (replacement) {
            form.set('expectedVersionId', replacement.versionId);
            form.set('retentionDays', '0');
        }
        const response = await app.request(
            replacement
                ? `/api/v1/admin/rag/documents/${replacement.id}/replacements`
                : '/api/v1/admin/rag/documents/uploads',
            {
                method: 'POST',
                headers: f.owner.headers(),
                body: form,
            }
        );
        assert.equal(response.status, 200, await response.clone().text());
        return uploadedDocument.parse(await response.json());
    }
    async function assertStored(
        result: { id: string; versionId: string },
        size: number
    ) {
        documents.set(result.id, result.versionId);
        const version = await prisma.documentVersion.findUniqueOrThrow({
            where: { id: result.versionId },
            include: { ingestion: true },
        });
        assert.equal(version.organizationId, f.organizationId);
        assert.equal(version.byteSize, BigInt(size));
        assert.ok(version.storedAt);
        assert.equal(version.ingestion?.status, 'PENDING');
    }
    try {
        await t.test(
            'global ingress refuses oversized auth, RPC, REST and unmatched bodies before parsing or mutation',
            async () => {
                const before = await snapshot();
                const oversized = JSON.stringify({
                    name: 'Never persisted',
                    email: `body-rejected-${run}@example.test`,
                    password: 'Local-test-password-928!',
                    padding: 'a'.repeat(DEFAULT_REQUEST_BODY_BYTES),
                });
                for (const path of [
                    '/api/auth/sign-up/email',
                    '/api/auth/request-password-reset',
                    '/rpc/v1/admin/organization/get',
                    '/api/v1/admin/organization',
                    '/unmatched-before-parser',
                ]) {
                    const response = await app.request(path, {
                        method: 'POST',
                        headers: {
                            'content-type': 'application/json',
                            origin: 'http://localhost:3000',
                        },
                        body: oversized,
                    });
                    assert.equal(response.status, 413, path);
                    assert.ok(
                        !(await response
                            .text()
                            .then((text) => text.includes('Never persisted')))
                    );
                }
                await assert.rejects(
                    f.owner.client().admin.organization.apiKeys.create({
                        name: 'a'.repeat(DEFAULT_REQUEST_BODY_BYTES),
                        permissions: { settings: ['read'] },
                    }),
                    { code: 'PAYLOAD_TOO_LARGE', status: 413 }
                );
                assert.deepEqual(await snapshot(), before);
                assert.equal(
                    await prisma.user.findUnique({
                        where: { email: `body-rejected-${run}@example.test` },
                    }),
                    null
                );
                assert.equal((await app.request('/health')).status, 200);
                // CORS preflight has no application parser and intentionally short-circuits the ingress guard.
                const preflight = await app.request(
                    '/api/v1/admin/organization',
                    {
                        method: 'OPTIONS',
                        headers: {
                            origin: 'http://localhost:3000',
                            'access-control-request-method': 'POST',
                            'content-length': String(
                                DOCUMENT_REQUEST_BODY_BYTES + 1
                            ),
                        },
                    }
                );
                assert.equal(preflight.status, 204);
            }
        );

        await t.test(
            'all four RPC and REST upload and replacement contracts accept genuine multipart bodies above 1 MiB',
            async () => {
                const file = smallFile();
                const rpc = await rag.documents.upload({
                    requestId: randomUUID(),
                    file,
                });
                await assertStored(rpc, file.size);
                const rest = await restUpload(file);
                await assertStored(rest, file.size);
                for (let attempt = 0; attempt < 4; attempt++) {
                    await processDocumentIngestions(prisma);
                    if (
                        (await prisma.documentIngestion.count({
                            where: {
                                versionId: {
                                    in: [rpc.versionId, rest.versionId],
                                },
                                status: 'READY',
                            },
                        })) === 2
                    )
                        break;
                }
                assert.equal(
                    await prisma.documentIngestion.count({
                        where: {
                            versionId: { in: [rpc.versionId, rest.versionId] },
                            status: 'READY',
                        },
                    }),
                    2
                );
                const rpcReplacement = await rag.documents.replace({
                    id: rpc.id,
                    expectedVersionId: rpc.versionId,
                    requestId: randomUUID(),
                    file,
                    retentionDays: 0,
                });
                await assertStored(rpcReplacement, file.size);
                const restReplacement = await restUpload(file, rest);
                await assertStored(restReplacement, file.size);
                assert.notEqual(rpcReplacement.versionId, rpc.versionId);
                assert.notEqual(restReplacement.versionId, rest.versionId);
            }
        );

        await t.test(
            'oversized upload envelopes and near-miss paths cannot reserve storage or durable work',
            async () => {
                const document = [...documents.entries()][0];
                assert.ok(document);
                const before = await snapshot();
                const oversized = new Uint8Array(
                    DOCUMENT_REQUEST_BODY_BYTES + 1
                );
                for (const path of [
                    '/rpc/v1/admin/rag/documents/upload',
                    '/rpc/v1/admin/rag/documents/replace',
                    '/api/v1/admin/rag/documents/uploads',
                    `/api/v1/admin/rag/documents/${document[0]}/replacements`,
                ]) {
                    const response = await app.request(path, {
                        method: 'POST',
                        headers: f.owner.headers({
                            'content-type': 'application/octet-stream',
                        }),
                        body: oversized,
                    });
                    assert.equal(response.status, 413, path);
                }
                const aboveDefault = new Uint8Array(
                    DEFAULT_REQUEST_BODY_BYTES + 1
                );
                for (const [method, path] of [
                    ['PUT', '/rpc/v1/admin/rag/documents/upload'],
                    ['POST', '/rpc/v1/admin/rag/documents/upload/extra'],
                    ['POST', '/rpc/v1/admin/rag/documents/upload/'],
                    ['POST', '/api/v1/admin/rag/documents/uploads-suffix'],
                    ['POST', '/prefix/api/v1/admin/rag/documents/uploads'],
                ] as const) {
                    assert.equal(
                        (
                            await app.request(path, {
                                method,
                                headers: f.owner.headers(),
                                body: aboveDefault,
                            })
                        ).status,
                        413,
                        `${method} ${path}`
                    );
                }
                // Multipart overhead fits the envelope, but the public file contract still caps the original at 25 MiB.
                await assert.rejects(
                    rag.documents.upload({
                        requestId: randomUUID(),
                        file: new File(
                            [new Uint8Array(25 * 1024 * 1024 + 1)],
                            'over-file-limit.txt'
                        ),
                    }),
                    { code: 'BAD_REQUEST', status: 400 }
                );
                assert.deepEqual(await snapshot(), before);
            }
        );

        await t.test(
            'an exact 25 MiB original fits its multipart envelope and is queued without document extraction in the request',
            async () => {
                const file = new File(
                    [new Uint8Array(25 * 1024 * 1024).fill(65)],
                    'maximum-original.txt',
                    { type: 'text/plain' }
                );
                const result = await rag.documents.upload({
                    requestId: randomUUID(),
                    file,
                });
                await assertStored(result, file.size);
                assert.equal(
                    await prisma.documentExtraction.count({
                        where: { versionId: result.versionId },
                    }),
                    0
                );
            }
        );
    } finally {
        // No extraction worker sees the 25 MiB fixture; deletion uses the real durable cleanup protocol.
        for (const [id, versionId] of documents)
            await rag.documents.delete({
                id,
                expectedVersionId: versionId,
                retentionDays: 0,
            });
        for (let attempt = 0; attempt < 5; attempt++) {
            await processDocumentCleanups(prisma);
            const outstanding = await prisma.documentCleanup.count({
                where: {
                    organizationId: f.organizationId,
                    version: { documentId: { in: [...documents.keys()] } },
                    status: { not: 'COMPLETE' },
                },
            });
            if (!outstanding) break;
        }
        assert.equal(
            await prisma.documentVersion.count({
                where: {
                    organizationId: f.organizationId,
                    documentId: { in: [...documents.keys()] },
                    contentState: { not: 'PURGED' },
                },
            }),
            0,
            'Accepted originals must be physically purged before core organization teardown.'
        );
    }
}
