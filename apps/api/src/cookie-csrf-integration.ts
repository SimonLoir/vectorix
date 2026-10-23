import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { VECTORIX_API_V1 } from '@repo/api/versioning';
import {
    VECTORIX_CSRF_HEADER,
    VECTORIX_CSRF_VALUE,
} from '@repo/api/transport-security';
import { prisma } from '@repo/db';
import { processDocumentCleanups } from '@routers/rag/cleanup';
import { z } from 'zod';
import { app } from './app';

type Browser = {
    headers(extra?: Record<string, string>): Record<string, string>;
    client(extra?: Record<string, string>): VectorixApiV1Client;
};
type Fixture = {
    owner: Browser;
    foreign: Browser;
    organizationId: string;
    foreignOrganizationId: string;
};
const trusted = 'http://localhost:3000';
const hostile = 'https://csrf-attacker.example.test';
const forbidden = {
    defined: false,
    code: 'FORBIDDEN',
    status: 403,
    message: 'Request origin is not allowed.',
};
const documentResult = z.object({ id: z.string(), versionId: z.string() });

function sessionHeaders(browser: Browser, extra: Record<string, string> = {}) {
    const headers = new Headers(browser.headers());
    headers.delete('origin');
    for (const [name, value] of Object.entries(extra)) headers.set(name, value);
    return headers;
}

/** Uses the actual fetch codec and app middleware; the saved response is a separate, bounded error-envelope copy. */
function rpc(headers: HeadersInit) {
    let response: Response | undefined;
    const client = createORPCClient<VectorixApiV1Client>(
        new RPCLink({
            url: 'http://localhost:3001/rpc/v1',
            headers: new Headers(headers),
            fetch: async (request) => {
                const result = await app.request(request);
                response = result.clone();
                return result;
            },
        })
    );
    return {
        client,
        response() {
            assert.ok(response, 'The native HTTP transport must have run.');
            return response;
        },
    };
}

function versionHeaders(response: Response) {
    assert.equal(response.headers.get('Vectorix-API-Version'), '1');
    assert.equal(
        response.headers.get('Vectorix-API-Revision'),
        String(VECTORIX_API_V1.revision)
    );
}

async function assertForbidden(response: Response, isRpc: boolean) {
    assert.equal(response.status, 403);
    versionHeaders(response);
    assert.deepEqual(
        await response.json(),
        isRpc ? { json: forbidden } : forbidden
    );
    assert.equal(response.headers.get('access-control-allow-origin'), null);
}

/** Exercises cookie admission before real mutations and native JSON/multipart parsing in the isolated core catalog. */
export async function cookieCsrfIntegrationTests(t: TestContext, f: Fixture) {
    const run = randomUUID().slice(0, 8);
    let sequence = 0;
    const documents = new Map<string, string>();
    const marker = { [VECTORIX_CSRF_HEADER]: VECTORIX_CSRF_VALUE };
    const mutation = () => ({
        name: `CSRF ${run}-${++sequence}`,
        permissions: { settings: ['read'] },
    });
    // Safe projections deliberately exclude session tokens, key hashes and other secrets.
    const snapshot = async () => {
        const [
            organization,
            keys,
            documents,
            versions,
            ingestions,
            audit,
            ragAudit,
        ] = await Promise.all([
            prisma.organization.findUniqueOrThrow({
                where: { id: f.organizationId },
                select: { id: true, name: true, isActive: true },
            }),
            prisma.apikey.findMany({
                where: { referenceId: f.organizationId },
                select: { id: true, requestCount: true, lastRequest: true },
                orderBy: { id: 'asc' },
            }),
            prisma.document.count({
                where: { organizationId: f.organizationId },
            }),
            prisma.documentVersion.count({
                where: { organizationId: f.organizationId },
            }),
            prisma.documentIngestion.count({
                where: { organizationId: f.organizationId },
            }),
            prisma.superAdminAuditLog.count({
                where: { targetId: f.organizationId },
            }),
            prisma.ragAuditLog.count({
                where: { organizationId: f.organizationId },
            }),
        ]);
        return {
            organization,
            keys,
            documents,
            versions,
            ingestions,
            audit,
            ragAudit,
        };
    };
    const upload = async (headers: HeadersInit) => {
        const result = await rpc(headers).client.admin.rag.documents.upload({
            requestId: randomUUID(),
            file: new File(
                ['Cookie CSRF fixture — bonjour / hello.\n'],
                `csrf-${run}.txt`,
                { type: 'text/plain' }
            ),
        });
        documents.set(result.id, result.versionId);
        return result;
    };
    const restUpload = async (headers: HeadersInit) => {
        const form = new FormData();
        form.set('requestId', randomUUID());
        form.set(
            'file',
            new File(['Private REST CSRF fixture.\n'], `csrf-rest-${run}.txt`, {
                type: 'text/plain',
            })
        );
        const response = await app.request(
            '/api/v1/admin/rag/documents/uploads',
            {
                method: 'POST',
                headers,
                body: form,
            }
        );
        if (response.ok) {
            const result = documentResult.parse(await response.clone().json());
            documents.set(result.id, result.versionId);
        }
        return response;
    };
    try {
        await t.test(
            'cookie JSON mutations honor explicit Origin and Referer precedence without side effects on denial',
            async () => {
                const cases: {
                    headers: Record<string, string>;
                    allowed: boolean;
                }[] = [
                    { headers: { origin: trusted }, allowed: true },
                    {
                        headers: {
                            origin: trusted,
                            referer: `${hostile}/page`,
                            [VECTORIX_CSRF_HEADER]: 'wrong',
                        },
                        allowed: true,
                    },
                    {
                        headers: { origin: trusted, referer: 'not-a-url' },
                        allowed: true,
                    },
                    {
                        headers: {
                            origin: hostile,
                            referer: `${trusted}/page`,
                            ...marker,
                        },
                        allowed: false,
                    },
                    { headers: { origin: 'null', ...marker }, allowed: false },
                    {
                        headers: {
                            origin: '',
                            referer: `${trusted}/page`,
                            ...marker,
                        },
                        allowed: false,
                    },
                    {
                        headers: { origin: `${trusted}/`, ...marker },
                        allowed: false,
                    },
                    {
                        headers: {
                            origin: 'not-an-origin',
                            referer: `${trusted}/page`,
                            ...marker,
                        },
                        allowed: false,
                    },
                    {
                        headers: { referer: `${trusted}/dashboard?tab=keys` },
                        allowed: true,
                    },
                    {
                        headers: { referer: `${hostile}/page`, ...marker },
                        allowed: false,
                    },
                    {
                        headers: { referer: 'not-a-url', ...marker },
                        allowed: false,
                    },
                    { headers: { referer: '', ...marker }, allowed: false },
                ];
                for (const entry of cases) {
                    const transport = rpc(
                        sessionHeaders(f.owner, entry.headers)
                    );
                    const before = await snapshot();
                    if (entry.allowed) {
                        const key =
                            await transport.client.admin.organization.apiKeys.create(
                                mutation()
                            );
                        assert.ok(
                            await prisma.apikey.findUnique({
                                where: { id: key.id },
                                select: { id: true },
                            })
                        );
                        assert.equal(
                            (await snapshot()).keys.length,
                            before.keys.length + 1
                        );
                        versionHeaders(transport.response());
                    } else {
                        await assert.rejects(
                            transport.client.admin.organization.apiKeys.create(
                                mutation()
                            ),
                            {
                                code: 'FORBIDDEN',
                                status: 403,
                                message: forbidden.message,
                            }
                        );
                        await assertForbidden(transport.response(), true);
                        assert.deepEqual(await snapshot(), before);
                    }
                }
            }
        );

        await t.test(
            'only the exact static marker admits cookie POSTs with both provenance headers absent',
            async () => {
                const refused: Record<string, string>[] = [
                    {},
                    { [VECTORIX_CSRF_HEADER]: 'ORPC' },
                    { [VECTORIX_CSRF_HEADER]: 'orpc, orpc' },
                    {
                        'x-requested-with': 'XMLHttpRequest',
                        'sec-fetch-site': 'same-origin',
                    },
                ];
                for (const extra of refused) {
                    const before = await snapshot();
                    const transport = rpc(sessionHeaders(f.owner, extra));
                    await assert.rejects(
                        transport.client.admin.organization.apiKeys.create(
                            mutation()
                        ),
                        { code: 'FORBIDDEN', status: 403 }
                    );
                    await assertForbidden(transport.response(), true);
                    assert.deepEqual(await snapshot(), before);
                }
                const before = await snapshot();
                await rpc(
                    sessionHeaders(f.owner, marker)
                ).client.admin.organization.apiKeys.create(mutation());
                assert.equal(
                    (await snapshot()).keys.length,
                    before.keys.length + 1
                );
            }
        );

        await t.test(
            'native multipart RPC and REST forms preserve bytes when admitted and allocate nothing when rejected',
            async () => {
                const refused: Record<string, string>[] = [
                    { origin: hostile, ...marker },
                    { origin: 'null', ...marker },
                    {},
                ];
                for (const extra of refused) {
                    const before = await snapshot();
                    await assert.rejects(
                        upload(sessionHeaders(f.owner, extra)),
                        { code: 'FORBIDDEN', status: 403 }
                    );
                    await assertForbidden(
                        await restUpload(sessionHeaders(f.owner, extra)),
                        false
                    );
                    assert.deepEqual(await snapshot(), before);
                }
                // A browser simple form is refused before its unsupported file field can be parsed.
                const before = await snapshot();
                await assertForbidden(
                    await app.request('/api/v1/admin/rag/documents/uploads', {
                        method: 'POST',
                        headers: sessionHeaders(f.owner, {
                            origin: hostile,
                            'content-type': 'application/x-www-form-urlencoded',
                        }),
                        body: new URLSearchParams({
                            requestId: randomUUID(),
                            file: 'not-a-file',
                        }),
                    }),
                    false
                );
                assert.deepEqual(await snapshot(), before);
                const admitted: Record<string, string>[] = [
                    { origin: trusted },
                    marker,
                ];
                for (const extra of admitted) {
                    const accepted = await upload(
                        sessionHeaders(f.owner, extra)
                    );
                    const stored =
                        await prisma.documentVersion.findUniqueOrThrow({
                            where: { id: accepted.versionId },
                            select: {
                                byteSize: true,
                                storedAt: true,
                                sha256: true,
                            },
                        });
                    assert.equal(
                        stored.byteSize,
                        BigInt(
                            Buffer.byteLength(
                                'Cookie CSRF fixture — bonjour / hello.\n'
                            )
                        )
                    );
                    assert.equal(
                        stored.sha256,
                        createHash('sha256')
                            .update('Cookie CSRF fixture — bonjour / hello.\n')
                            .digest('hex')
                    );
                    assert.ok(stored.storedAt);
                }
                const rest = await restUpload(
                    sessionHeaders(f.owner, { origin: trusted })
                );
                assert.equal(rest.status, 200);
                versionHeaders(rest);
                assert.equal(
                    rest.headers.get('access-control-allow-origin'),
                    trusted
                );
            }
        );

        await t.test(
            'superadmin cookie mutations are protected and trusted REST requests retain CORS and version headers',
            async () => {
                const before = await snapshot();
                const transport = rpc(
                    sessionHeaders(f.owner, { origin: hostile, ...marker })
                );
                await assert.rejects(
                    transport.client.superadmin.organizations.update({
                        organizationId: f.organizationId,
                        name: 'CSRF must not rename',
                    }),
                    { code: 'FORBIDDEN', status: 403 }
                );
                await assertForbidden(transport.response(), true);
                await assertForbidden(
                    await app.request(
                        `/api/v1/superadmin/organizations/${f.organizationId}`,
                        {
                            method: 'PUT',
                            headers: sessionHeaders(f.owner, {
                                origin: hostile,
                                'content-type': 'application/json',
                                ...marker,
                            }),
                            body: JSON.stringify({
                                name: 'CSRF must not rename',
                            }),
                        }
                    ),
                    false
                );
                assert.deepEqual(await snapshot(), before);
                const allowed = await app.request(
                    `/api/v1/superadmin/organizations/${f.organizationId}`,
                    {
                        method: 'PUT',
                        headers: sessionHeaders(f.owner, {
                            origin: 'http://localhost:3006',
                            'content-type': 'application/json',
                        }),
                        body: JSON.stringify({
                            name: before.organization.name,
                        }),
                    }
                );
                assert.equal(allowed.status, 200);
                versionHeaders(allowed);
                assert.equal(
                    allowed.headers.get('access-control-allow-origin'),
                    'http://localhost:3006'
                );
                assert.equal(
                    allowed.headers.get('access-control-allow-credentials'),
                    'true'
                );
                const preflight = await app.request(
                    '/rpc/v1/superadmin/organizations/update',
                    {
                        method: 'OPTIONS',
                        headers: {
                            origin: trusted,
                            'access-control-request-method': 'POST',
                            'access-control-request-headers': `${VECTORIX_CSRF_HEADER},content-type`,
                        },
                    }
                );
                assert.equal(preflight.status, 204);
                assert.ok(
                    preflight.headers
                        .get('access-control-allow-headers')
                        ?.toLowerCase()
                        .split(',')
                        .map((value) => value.trim())
                        .includes(VECTORIX_CSRF_HEADER.toLowerCase())
                );
            }
        );

        await t.test(
            'cookie-free keys and bearer sessions remain usable while any Cookie keeps their requests protected',
            async () => {
                const key = await f.owner
                    .client()
                    .admin.organization.apiKeys.create(mutation());
                const member = await f.owner.client().admin.members.me({});
                const session = await prisma.session.findFirstOrThrow({
                    where: {
                        userId: member.userId,
                        activeOrganizationId: f.organizationId,
                    },
                    select: { token: true },
                });
                const authentication: Record<string, string>[] = [
                    { 'x-api-key': key.key },
                    { authorization: `Bearer ${session.token}` },
                ];
                const provenanceHeaders: Record<string, string>[] = [
                    { origin: hostile },
                    {},
                ];
                for (const credentials of authentication) {
                    for (const provenance of provenanceHeaders) {
                        assert.equal(
                            (
                                await rpc(
                                    new Headers({
                                        ...provenance,
                                        ...credentials,
                                    })
                                ).client.admin.organization.get({})
                            ).id,
                            f.organizationId
                        );
                    }
                    for (const cookie of [
                        f.owner.headers().cookie!,
                        'unrelated=present',
                    ]) {
                        const before = await snapshot();
                        const transport = rpc(
                            new Headers({
                                origin: hostile,
                                cookie,
                                ...credentials,
                                ...marker,
                            })
                        );
                        await assert.rejects(
                            transport.client.admin.organization.get({}),
                            { code: 'FORBIDDEN', status: 403 }
                        );
                        await assertForbidden(transport.response(), true);
                        assert.deepEqual(await snapshot(), before);
                    }
                }
            }
        );

        await t.test(
            'an invalid explicit key cannot fall back to the valid cookie session after CSRF admission',
            async () => {
                const before = await snapshot();
                const admitted: Record<string, string>[] = [
                    { origin: trusted },
                    marker,
                ];
                for (const extra of admitted) {
                    const transport = rpc(
                        sessionHeaders(f.owner, {
                            ...extra,
                            'x-api-key': 'invalid-csrf-test-key',
                        })
                    );
                    await assert.rejects(
                        transport.client.admin.organization.get({}),
                        { code: 'INVALID_API_KEY', status: 401 }
                    );
                    versionHeaders(transport.response());
                    assert.equal(transport.response().status, 401);
                }
                assert.deepEqual(await snapshot(), before);
            }
        );

        await t.test(
            'GET mutations remain method-rejected even with an authenticated cookie and a trusted origin',
            async () => {
                const before = await snapshot();
                const input = mutation();
                const url = new URL(
                    'http://localhost:3001/rpc/v1/admin/organization/apiKeys/create'
                );
                url.searchParams.set('data', JSON.stringify({ json: input }));
                const response = await app.request(url, {
                    headers: f.owner.headers(),
                });
                assert.equal(response.status, 405);
                versionHeaders(response);
                assert.equal(
                    response.headers.get('access-control-allow-origin'),
                    trusted
                );
                const rest = await app.request(
                    `/api/v1/superadmin/organizations/${f.organizationId}/members`,
                    { headers: f.owner.headers() }
                );
                assert.ok(rest.status === 404 || rest.status === 405);
                assert.deepEqual(await snapshot(), before);
            }
        );

        await t.test(
            'originless marker calls retain each request identity and enforce the authenticated tenant pin',
            async () => {
                const identities: string[] = [];
                for (const [browser, organizationId] of [
                    [f.owner, f.organizationId],
                    [f.foreign, f.foreignOrganizationId],
                    [f.owner, f.organizationId],
                ] as const) {
                    const client = rpc(
                        sessionHeaders(browser, {
                            ...marker,
                            'Vectorix-Expected-Organization-Id': organizationId,
                        })
                    ).client;
                    const member = await client.admin.members.me({});
                    assert.equal(member.organizationId, organizationId);
                    identities.push(member.userId);
                    assert.equal(
                        (await client.admin.organization.get({})).id,
                        organizationId
                    );
                }
                assert.equal(identities[0], identities[2]);
                assert.notEqual(identities[0], identities[1]);
                await assert.rejects(
                    rpc(
                        sessionHeaders(f.owner, {
                            ...marker,
                            'Vectorix-Expected-Organization-Id':
                                f.foreignOrganizationId,
                        })
                    ).client.admin.organization.get({}),
                    { code: 'CONFLICT', status: 409 }
                );
            }
        );
    } finally {
        for (const [id, versionId] of documents) {
            await f.owner.client().admin.rag.documents.delete({
                id,
                expectedVersionId: versionId,
                retentionDays: 0,
            });
        }
        for (let attempt = 0; attempt < 5 && documents.size; attempt++) {
            await processDocumentCleanups(prisma);
            if (
                !(await prisma.documentVersion.count({
                    where: {
                        organizationId: f.organizationId,
                        documentId: { in: [...documents.keys()] },
                        contentState: { not: 'PURGED' },
                    },
                }))
            )
                break;
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
            'Accepted CSRF fixture objects must be purged before core teardown.'
        );
    }
}
