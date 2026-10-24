import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { prisma } from '@repo/db';
import { app } from '../app';
import { fixture as f } from './fixtures';
import { createSemanticFixture } from './semantic-fixtures';

const legacyKeys = [
    'chunksPerCollection',
    'collections',
    'documents',
    'originalBytes',
    'storageBytes',
    'temporaryChunksPerCollection',
].toSorted();

/** Compatible HTTP contracts keep semantic capacity separate from the supported strict legacy quota shape. */
export async function semanticQuotaTests(t: TestContext) {
    const fixture = await createSemanticFixture('quotas');
    try {
        const user = await prisma.user.findUniqueOrThrow({
            where: { id: f.users[0] },
        });
        try {
            await prisma.user.update({
                where: { id: user.id },
                data: { isSuperAdmin: false },
            });
            await t.test(
                'semantic quota reads are organization-scoped, session-authorized and explicit about untracked or missing native usage',
                async () => {
                    const view = await f.owner.rag.quota({});
                    assert.deepEqual(
                        Object.keys(view.limits).toSorted(),
                        legacyKeys
                    );
                    assert(view.semantic);
                    assert.equal(view.semantic.usage.trackingSince, null);
                    assert.equal(view.semantic.usage.providerInputTokens, null);
                    assert.equal(view.semantic.usage.billedInputTokens, null);
                    assert.equal(view.semantic.usage.confirmedRequests, '0');
                    assert.equal(view.semantic.usage.dispatchedBatches, '0');
                    assert.equal(
                        view.semantic.limits.semanticUnitsPerDocument,
                        8192
                    );
                    assert.equal(
                        view.semantic.limits.embeddingBatchesPerCandidate,
                        4096
                    );
                    await assert.rejects(
                        f.other.client.superadmin.organizations.getSemanticQuota(
                            {
                                organizationId: f.org,
                            }
                        ),
                        { code: 'FORBIDDEN' }
                    );
                    await assert.rejects(
                        f.owner.client.superadmin.organizations.getSemanticQuota(
                            {
                                organizationId: f.org,
                            }
                        ),
                        { code: 'FORBIDDEN' }
                    );
                    await assert.rejects(
                        f.owner.client.superadmin.organizations.setSemanticQuota(
                            {
                                organizationId: f.org,
                                limits: view.semantic.limits,
                            }
                        ),
                        { code: 'FORBIDDEN' }
                    );
                }
            );
            await t.test(
                'separate semantic superadmin policy rejects invalid capacities and preserves all six legacy values in both directions',
                async () => {
                    await prisma.user.update({
                        where: { id: user.id },
                        data: { isSuperAdmin: true },
                    });
                    const legacy =
                        await f.owner.client.superadmin.organizations.getRagQuota(
                            {
                                organizationId: f.org,
                            }
                        );
                    const semantic =
                        await f.owner.client.superadmin.organizations.getSemanticQuota(
                            { organizationId: f.org }
                        );
                    await assert.rejects(
                        f.owner.client.superadmin.organizations.getSemanticQuota(
                            {
                                organizationId: randomUUID(),
                            }
                        ),
                        { code: 'NOT_FOUND' }
                    );
                    for (const limits of [
                        { ...semantic.limits, semanticUnitsPerDocument: 8193 },
                        {
                            ...semantic.limits,
                            semanticPlanBytesPerDocument: 1_048_577,
                        },
                        {
                            ...semantic.limits,
                            embeddingBatchesPerCandidate: 4097,
                        },
                        {
                            ...semantic.limits,
                            semanticPlanBytesPerOrganization: 1024,
                        },
                        {
                            ...semantic.limits,
                            embeddingOutstandingPreparedBytes: 1024,
                        },
                        { ...semantic.limits, embeddingOutstandingBatches: 1 },
                    ])
                        await assert.rejects(
                            f.owner.client.superadmin.organizations.setSemanticQuota(
                                { organizationId: f.org, limits }
                            ),
                            { code: 'BAD_REQUEST' }
                        );
                    const changed = {
                        ...semantic.limits,
                        semanticUnitsPerDocument: 2048,
                        embeddingBatchesPerCandidate: 1024,
                    };
                    assert.deepEqual(
                        await f.owner.client.superadmin.organizations.setSemanticQuota(
                            { organizationId: f.org, limits: changed }
                        ),
                        changed
                    );
                    const saved =
                        await f.owner.client.superadmin.organizations.getSemanticQuota(
                            { organizationId: f.org }
                        );
                    assert.deepEqual(saved.limits, changed);
                    assert.equal(saved.overridden, true);
                    assert.deepEqual(
                        (
                            await f.owner.client.superadmin.organizations.getRagQuota(
                                { organizationId: f.org }
                            )
                        ).limits,
                        legacy.limits
                    );
                    const newLegacy = { ...legacy.limits, documents: 1234 };
                    await f.owner.client.superadmin.organizations.setRagQuota({
                        organizationId: f.org,
                        limits: newLegacy,
                    });
                    const organizationView = await f.owner.rag.quota({});
                    assert.deepEqual(
                        Object.keys(organizationView.limits).toSorted(),
                        legacyKeys
                    );
                    assert.deepEqual(organizationView.limits, newLegacy);
                    assert.deepEqual(
                        organizationView.semantic?.limits,
                        changed
                    );
                    const audits = await prisma.ragAuditLog.findMany({
                        where: {
                            organizationId: f.org,
                            action: 'semanticQuota.update',
                        },
                    });
                    assert.equal(audits.length, 1);
                    assert.deepEqual(audits[0]!.details, changed);
                    const path = `/api/v1/superadmin/organizations/${f.org}/semantic-quota`;
                    const rest = await app.request(path, {
                        headers: f.owner.headers(),
                    });
                    assert.equal(rest.status, 200);
                    const restView: unknown = await rest.json();
                    assert(
                        restView &&
                            typeof restView === 'object' &&
                            'limits' in restView
                    );
                    assert.deepEqual(restView.limits, changed);
                    const updated = await app.request(path, {
                        method: 'PUT',
                        headers: {
                            ...f.owner.headers(),
                            'content-type': 'application/json',
                        },
                        body: JSON.stringify({ limits: changed }),
                    });
                    assert.equal(updated.status, 200);
                    assert.deepEqual(await updated.json(), changed);
                }
            );
            await t.test(
                'the current compatible API revision retains dedicated semantic quota routes',
                async () => {
                    const response = await app.request('/spec/v1.json');
                    assert.equal(response.status, 200);
                    assert.equal(
                        response.headers.get('Vectorix-API-Revision'),
                        '20'
                    );
                    const spec: unknown = await response.json();
                    assert(
                        spec &&
                            typeof spec === 'object' &&
                            'info' in spec &&
                            spec.info &&
                            typeof spec.info === 'object' &&
                            'version' in spec.info
                    );
                    assert.equal(spec.info.version, '1.21.0');
                    assert(
                        'paths' in spec &&
                            spec.paths &&
                            typeof spec.paths === 'object'
                    );
                    assert(
                        Object.keys(spec.paths).some((path) =>
                            path.endsWith('/semantic-quota')
                        )
                    );
                }
            );
        } finally {
            await prisma.user.update({
                where: { id: user.id },
                data: { isSuperAdmin: user.isSuperAdmin },
            });
        }
    } finally {
        await fixture.close();
    }
}
