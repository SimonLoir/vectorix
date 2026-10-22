import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { DecoratedProcedure, type RouterClient } from '@orpc/server';
import { RPCHandler } from '@orpc/server/fetch';
import { router, type VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { Pool } from 'pg';
import { logger } from './lib/logger';

type Browser = {
    post(path: string, body: unknown): Promise<unknown>;
    client(extra?: Record<string, string>): VectorixApiV1Client;
    headers(extra?: Record<string, string>): Record<string, string>;
};
type Fixture = {
    createBrowser(): Browser;
    foreignOrganizationId: string;
    registerUser(id: string): void;
    registerOrganization(id: string): void;
    registerFeature(id: string): void;
};

/** DDL is test-only: Prisma cannot express temporary fault/barrier triggers. */
function identifier(value: string): string {
    assert.match(value, /^test_sa_[a-z0-9_]+$/);
    return `"${value}"`;
}

function fixtureLiteral(value: string): string {
    assert.match(value, /^[a-zA-Z0-9_-]+$/);
    return `'${value}'`;
}

/** Reject only this test actor's audit insert, and always remove the fault. */
async function withAuditFailure(
    database: Pool,
    actorId: string,
    run: () => Promise<void>
) {
    const name = identifier(
        `test_sa_audit_${randomUUID().replaceAll('-', '')}`
    );
    try {
        await database.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW."userId" = ${fixtureLiteral(actorId)} THEN
                    RAISE EXCEPTION 'Controlled audit rejection';
                END IF;
                RETURN NEW;
            END;
        $$`);
        await database.query(`CREATE TRIGGER ${name} BEFORE INSERT ON "SuperAdminAuditLog"
            FOR EACH ROW EXECUTE FUNCTION ${name}()`);
        await run();
    } finally {
        await database.query(
            `DROP TRIGGER IF EXISTS ${name} ON "SuperAdminAuditLog"`
        );
        await database.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
}

/** Wait for both requests to reach the database barrier after their owner reads. */
async function waitForOwnerPredicates(database: Pool, key: number) {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
        const observation = await database.query<{ waiting: number }>(
            `SELECT count(*)::int AS waiting FROM pg_locks
             WHERE locktype='advisory' AND NOT granted AND classid=0
             AND objid=$1 AND objsubid=1
             AND database=(SELECT oid FROM pg_database WHERE datname=current_database())`,
            [key]
        );
        if (observation.rows[0]!.waiting === 2) return;
        await delay(10);
    }
    assert.fail(
        'Both superadmin owner mutations must reach the controlled predicate barrier.'
    );
}

/**
 * Synchronize two actual HTTP mutations after their owner predicates but before
 * either member write. This proves the superadmin transaction boundary only;
 * it does not install or claim an invariant for native auth mutation paths.
 */
async function concurrentOwnerMutations(
    database: Pool,
    organizationId: string,
    operations: readonly [() => Promise<unknown>, () => Promise<unknown>]
) {
    const name = identifier(
        `test_sa_owner_${randomUUID().replaceAll('-', '')}`
    );
    const key = Number.parseInt(randomUUID().slice(0, 7), 16);
    const blocker = await database.connect();
    let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
        await database.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                IF OLD."organizationId" = TG_ARGV[0] THEN
                    PERFORM pg_advisory_xact_lock(TG_ARGV[1]::bigint);
                END IF;
                IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
                RETURN NEW;
            END;
        $$`);
        await database.query(`CREATE TRIGGER ${name} BEFORE DELETE OR UPDATE OF role ON member
            FOR EACH ROW EXECUTE FUNCTION ${name}(${fixtureLiteral(organizationId)}, '${key}')`);
        await blocker.query('SELECT pg_advisory_lock($1::bigint)', [key]);
        pending = Promise.allSettled(
            operations.map((operation) => operation())
        );
        await waitForOwnerPredicates(database, key);
        await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
        return await pending;
    } finally {
        await blocker.query('SELECT pg_advisory_unlock($1::bigint)', [key]);
        blocker.release();
        await pending;
        await database.query(`DROP TRIGGER IF EXISTS ${name} ON member`);
        await database.query(`DROP FUNCTION IF EXISTS ${name}()`);
    }
}

/** Exercise atomic mutation/audit behavior through the disposable core HTTP fixture. */
export async function superadminTransactionIntegrationTests(
    t: TestContext,
    f: Fixture
) {
    const connectionString = process.env.DATABASE_URL;
    assert.ok(
        connectionString && new URL(connectionString).pathname.endsWith('_test')
    );
    const database = new Pool({ connectionString });
    const id = randomUUID().slice(0, 8);
    const password = 'Local-test-password-928!';
    async function account(label: string) {
        const browser = f.createBrowser();
        const email = `sa-tx-${label}-${id}@example.test`;
        await browser.post('sign-up/email', {
            name: `Transaction ${label}`,
            email,
            password,
        });
        const user = await prisma.user.findUniqueOrThrow({ where: { email } });
        f.registerUser(user.id);
        return { browser, user };
    }
    const actor = await account('actor');
    await prisma.user.update({
        where: { id: actor.user.id },
        data: { isSuperAdmin: true },
    });
    const client = actor.browser.client({
        'x-forwarded-for': '203.0.113.18, 198.51.100.90',
        'x-real-ip': '203.0.113.19',
        forwarded: 'for=203.0.113.20;proto=https',
    }).superadmin;
    const target = await account('target');
    const owners = await Promise.all([account('owner-a'), account('owner-b')]);
    async function organization(label: string) {
        const result = await client.organizations.create({
            name: `Transaction ${label}`,
            slug: `sa-tx-${label}-${id}`,
        });
        f.registerOrganization(result.id);
        return result;
    }
    const originalOrganization = await organization('original');
    const originalFeature = await client.features.create({
        key: `sa-tx-original-${id}`,
        name: 'Original transaction feature',
    });
    f.registerFeature(originalFeature.id);
    const originalMember = (
        await client.organizations.members.add({
            organizationId: originalOrganization.id,
            email: target.user.email,
            role: 'owner',
        })
    ).member;
    await client.organizations.members.add({
        organizationId: originalOrganization.id,
        email: owners[0]!.user.email,
        role: 'owner',
    });
    await target.browser.post('organization/set-active', {
        organizationId: originalOrganization.id,
    });
    const scopedKey = await target.browser
        .client()
        .admin.organization.apiKeys.create({
            name: `Rollback ${id}`,
            permissions: { settings: ['read'] },
        });
    const principal = await prisma.apiKeyPrincipal.findUniqueOrThrow({
        where: { keyId: scopedKey.id },
    });

    async function auditIds() {
        return new Set(
            (
                await prisma.superAdminAuditLog.findMany({
                    where: { userId: actor.user.id },
                    select: { id: true },
                })
            ).map((row) => row.id)
        );
    }
    async function oneAudit<T>(
        action: string,
        operation: () => Promise<T>,
        targetId: (result: T) => string
    ) {
        const before = await auditIds();
        const result = await operation();
        const added = (
            await prisma.superAdminAuditLog.findMany({
                where: { userId: actor.user.id },
            })
        ).filter((row) => !before.has(row.id));
        assert.equal(
            added.length,
            1,
            'Each successful mutation must add exactly one audit row.'
        );
        assert.equal(added[0]!.action, `vectorix.${action}`);
        assert.equal(added[0]!.targetId, targetId(result));
        assert.equal(
            added[0]!.ipAddress,
            null,
            'Untrusted forwarding headers must not become audit peer identity.'
        );
        return result;
    }
    async function rejectedMutation(operation: () => Promise<unknown>) {
        const before = await auditIds();
        await assert.rejects(operation(), { code: 'INTERNAL_SERVER_ERROR' });
        assert.deepEqual(await auditIds(), before);
    }

    try {
        await withAuditFailure(database, actor.user.id, async () => {
            await t.test(
                'superadmin organization creation rolls back when audit persistence fails',
                async () => {
                    const slug = `sa-tx-rejected-${id}`;
                    await rejectedMutation(() =>
                        client.organizations.create({
                            name: 'Rejected organization',
                            slug,
                        })
                    );
                    assert.equal(
                        await prisma.organization.count({ where: { slug } }),
                        0
                    );
                }
            );
            await t.test(
                'superadmin organization changes roll back with their audit',
                async () => {
                    const before = await prisma.organization.findUniqueOrThrow({
                        where: { id: originalOrganization.id },
                    });
                    await rejectedMutation(() =>
                        client.organizations.update({
                            organizationId: originalOrganization.id,
                            name: 'Must not persist',
                            isActive: false,
                            metadata: 'must-not-persist',
                        })
                    );
                    assert.deepEqual(
                        await prisma.organization.findUniqueOrThrow({
                            where: { id: originalOrganization.id },
                        }),
                        before
                    );
                }
            );
            await t.test(
                'superadmin member creation rolls back the new user, credential account and membership',
                async () => {
                    const email = `sa-tx-rejected-user-${id}@example.test`;
                    await rejectedMutation(() =>
                        client.organizations.members.add({
                            organizationId: originalOrganization.id,
                            email,
                            name: 'Rejected account',
                            password,
                            role: 'member',
                        })
                    );
                    assert.equal(
                        await prisma.user.count({ where: { email } }),
                        0
                    );
                    assert.equal(
                        await prisma.account.count({
                            where: { user: { email } },
                        }),
                        0
                    );
                    assert.equal(
                        await prisma.member.count({
                            where: {
                                organizationId: originalOrganization.id,
                                user: { email },
                            },
                        }),
                        0
                    );
                }
            );
            await t.test(
                'superadmin adding an existing user rolls back only the new membership',
                async () => {
                    const existing = owners[1]!;
                    const accounts = await prisma.account.findMany({
                        where: { userId: existing.user.id },
                        orderBy: { id: 'asc' },
                    });
                    await rejectedMutation(() =>
                        client.organizations.members.add({
                            organizationId: originalOrganization.id,
                            email: existing.user.email,
                            role: 'member',
                        })
                    );
                    assert.equal(
                        await prisma.member.count({
                            where: {
                                organizationId: originalOrganization.id,
                                userId: existing.user.id,
                            },
                        }),
                        0
                    );
                    assert.ok(
                        isDeepStrictEqual(
                            await prisma.account.findMany({
                                where: { userId: existing.user.id },
                                orderBy: { id: 'asc' },
                            }),
                            accounts
                        ),
                        'Audit failure must preserve existing credential account records.'
                    );
                }
            );
            await t.test(
                'superadmin member role changes roll back with their audit',
                async () => {
                    const before = await prisma.member.findUniqueOrThrow({
                        where: { id: originalMember.id },
                    });
                    await rejectedMutation(() =>
                        client.organizations.members.updateRole({
                            organizationId: originalOrganization.id,
                            memberId: originalMember.id,
                            role: 'member',
                        })
                    );
                    assert.deepEqual(
                        await prisma.member.findUniqueOrThrow({
                            where: { id: originalMember.id },
                        }),
                        before
                    );
                }
            );
            await t.test(
                'superadmin removal restores membership, issuer principal and active sessions after audit failure',
                async () => {
                    const sessions = await prisma.session.findMany({
                        where: { userId: target.user.id },
                        orderBy: { id: 'asc' },
                    });
                    assert.ok(
                        sessions.some(
                            (session) =>
                                session.activeOrganizationId ===
                                originalOrganization.id
                        )
                    );
                    await rejectedMutation(() =>
                        client.organizations.members.remove({
                            organizationId: originalOrganization.id,
                            memberId: originalMember.id,
                        })
                    );
                    assert.equal(
                        (
                            await prisma.member.findUniqueOrThrow({
                                where: { id: originalMember.id },
                            })
                        ).userId,
                        target.user.id
                    );
                    assert.deepEqual(
                        await prisma.apiKeyPrincipal.findUniqueOrThrow({
                            where: { keyId: scopedKey.id },
                        }),
                        principal
                    );
                    assert.ok(
                        isDeepStrictEqual(
                            await prisma.session.findMany({
                                where: { userId: target.user.id },
                                orderBy: { id: 'asc' },
                            }),
                            sessions
                        ),
                        'Audit failure must preserve target session records.'
                    );
                }
            );
            await t.test(
                'superadmin feature creation rolls back when audit persistence fails',
                async () => {
                    const key = `sa-tx-rejected-${id}`;
                    await rejectedMutation(() =>
                        client.features.create({
                            key,
                            name: 'Rejected feature',
                        })
                    );
                    assert.equal(
                        await prisma.vectorixFeatureDefinition.count({
                            where: { key },
                        }),
                        0
                    );
                }
            );
            await t.test(
                'superadmin feature changes roll back with their audit',
                async () => {
                    const before =
                        await prisma.vectorixFeatureDefinition.findUniqueOrThrow(
                            { where: { id: originalFeature.id } }
                        );
                    await rejectedMutation(() =>
                        client.features.update({
                            featureId: originalFeature.id,
                            name: 'Must not persist',
                            defaultEnabled: false,
                            isActive: false,
                        })
                    );
                    assert.deepEqual(
                        await prisma.vectorixFeatureDefinition.findUniqueOrThrow(
                            { where: { id: originalFeature.id } }
                        ),
                        before
                    );
                }
            );
        });

        await t.test(
            'all seven superadmin mutations commit one audit and ignore spoofed network identity',
            async () => {
                const created = await oneAudit(
                    'organization.create',
                    () =>
                        client.organizations.create({
                            name: 'Audited organization',
                            slug: `sa-tx-success-${id}`,
                        }),
                    (result) => result.id
                );
                f.registerOrganization(created.id);
                await oneAudit(
                    'organization.update',
                    () =>
                        client.organizations.update({
                            organizationId: created.id,
                            name: 'Updated audited organization',
                        }),
                    () => created.id
                );
                const added = await oneAudit(
                    'organization.member.create-user',
                    () =>
                        client.organizations.members.add({
                            organizationId: created.id,
                            email: `sa-tx-new-user-${id}@example.test`,
                            name: 'Created account',
                            password,
                            role: 'owner',
                        }),
                    () => created.id
                );
                f.registerUser(added.member.user.id);
                assert.equal(added.userCreated, true);
                assert.equal(
                    await prisma.account.count({
                        where: {
                            userId: added.member.user.id,
                            providerId: 'credential',
                        },
                    }),
                    1
                );
                const attached = await oneAudit(
                    'organization.member.add-existing-user',
                    () =>
                        client.organizations.members.add({
                            organizationId: created.id,
                            email: target.user.email,
                            role: 'admin',
                        }),
                    () => created.id
                );
                assert.equal(attached.userCreated, false);
                await oneAudit(
                    'organization.member.update-role',
                    () =>
                        client.organizations.members.updateRole({
                            organizationId: created.id,
                            memberId: attached.member.id,
                            role: 'member',
                        }),
                    () => created.id
                );
                await target.browser.post('organization/set-active', {
                    organizationId: created.id,
                });
                await oneAudit(
                    'organization.member.remove',
                    () =>
                        client.organizations.members.remove({
                            organizationId: created.id,
                            memberId: attached.member.id,
                        }),
                    () => created.id
                );
                assert.equal(
                    await prisma.member.count({
                        where: { id: attached.member.id },
                    }),
                    0
                );
                assert.equal(
                    await prisma.session.count({
                        where: {
                            userId: target.user.id,
                            activeOrganizationId: created.id,
                        },
                    }),
                    0
                );
                assert.equal(
                    (
                        await prisma.member.findUniqueOrThrow({
                            where: { id: originalMember.id },
                        })
                    ).organizationId,
                    originalOrganization.id
                );
                const feature = await oneAudit(
                    'feature.create',
                    () =>
                        client.features.create({
                            key: `sa-tx-success-${id}`,
                            name: 'Audited feature',
                        }),
                    (result) => result.id
                );
                f.registerFeature(feature.id);
                await oneAudit(
                    'feature.update',
                    () =>
                        client.features.update({
                            featureId: feature.id,
                            name: 'Updated audited feature',
                            isPaywalled: true,
                        }),
                    () => feature.id
                );
            }
        );

        await t.test(
            'foreign member identifiers cannot mutate another organization or add an audit',
            async () => {
                const foreign = await prisma.member.findFirstOrThrow({
                    where: { organizationId: f.foreignOrganizationId },
                });
                const before = await auditIds();
                await assert.rejects(
                    client.organizations.members.updateRole({
                        organizationId: originalOrganization.id,
                        memberId: foreign.id,
                        role: 'admin',
                    }),
                    { code: 'NOT_FOUND' }
                );
                await assert.rejects(
                    client.organizations.members.remove({
                        organizationId: originalOrganization.id,
                        memberId: foreign.id,
                    }),
                    { code: 'NOT_FOUND' }
                );
                assert.deepEqual(
                    await prisma.member.findUniqueOrThrow({
                        where: { id: foreign.id },
                    }),
                    foreign
                );
                assert.deepEqual(await auditIds(), before);
            }
        );

        for (const mode of [
            'remove-remove',
            'demote-demote',
            'remove-demote',
        ] as const) {
            await t.test(
                `concurrent superadmin ${mode} operations preserve one owner`,
                async () => {
                    const race = await organization(mode);
                    const memberIds: string[] = [];
                    for (const owner of owners) {
                        const member = (
                            await client.organizations.members.add({
                                organizationId: race.id,
                                email: owner.user.email,
                                role: 'owner',
                            })
                        ).member;
                        memberIds.push(member.id);
                        await owner.browser.post('organization/set-active', {
                            organizationId: race.id,
                        });
                    }
                    const before = await auditIds();
                    const first = () =>
                        mode === 'demote-demote'
                            ? client.organizations.members.updateRole({
                                  organizationId: race.id,
                                  memberId: memberIds[0]!,
                                  role: 'admin',
                              })
                            : client.organizations.members.remove({
                                  organizationId: race.id,
                                  memberId: memberIds[0]!,
                              });
                    const second = () =>
                        mode === 'remove-remove'
                            ? client.organizations.members.remove({
                                  organizationId: race.id,
                                  memberId: memberIds[1]!,
                              })
                            : client.organizations.members.updateRole({
                                  organizationId: race.id,
                                  memberId: memberIds[1]!,
                                  role: 'member',
                              });
                    const results = await concurrentOwnerMutations(
                        database,
                        race.id,
                        [first, second]
                    );
                    assert.equal(
                        results.filter(
                            (result) => result.status === 'fulfilled'
                        ).length,
                        1
                    );
                    const failed = results.find(
                        (result) => result.status === 'rejected'
                    );
                    assert.ok(failed?.status === 'rejected');
                    const reason: unknown = failed.reason;
                    assert.ok(
                        reason && typeof reason === 'object' && 'code' in reason
                    );
                    assert.ok(
                        typeof reason.code === 'string' &&
                            ['BAD_REQUEST', 'CONFLICT'].includes(reason.code)
                    );
                    const remaining = await prisma.member.findMany({
                        where: { organizationId: race.id },
                    });
                    const remainingOwners = remaining.filter((member) =>
                        member.role
                            .split(',')
                            .map((role) => role.trim())
                            .includes('owner')
                    );
                    assert.equal(remainingOwners.length, 1);
                    const addedAudits = (
                        await prisma.superAdminAuditLog.findMany({
                            where: { userId: actor.user.id },
                        })
                    ).filter((row) => !before.has(row.id));
                    assert.equal(
                        addedAudits.length,
                        1,
                        'The serialized loser must not leave an audit row.'
                    );
                    assert.equal(addedAudits[0]!.ipAddress, null);
                    for (const owner of owners) {
                        if (
                            remaining.some(
                                (member) => member.userId === owner.user.id
                            )
                        )
                            continue;
                        assert.equal(
                            await prisma.session.count({
                                where: {
                                    userId: owner.user.id,
                                    activeOrganizationId: race.id,
                                },
                            }),
                            0
                        );
                    }
                }
            );
        }

        await t.test(
            'a superadmin revoked after HTTP middleware admission cannot commit with a stale context',
            async () => {
                let admitted = false;
                const routes = {
                    create: new DecoratedProcedure(
                        router.superadmin.organizations.create['~orpc']
                    ).use(async ({ context, next }) => {
                        assert.equal(context.user.id, actor.user.id);
                        assert.equal(context.user.isSuperAdmin, true);
                        admitted = true;
                        await prisma.user.update({
                            where: { id: actor.user.id },
                            data: { isSuperAdmin: false },
                        });
                        return next();
                    }),
                };
                const handler = new RPCHandler(routes);
                const stale = createORPCClient<RouterClient<typeof routes>>(
                    new RPCLink({
                        url: 'http://localhost:3001/superadmin-stale-context-test',
                        headers: actor.browser.headers(),
                        fetch: async (request) => {
                            const result = await handler.handle(request, {
                                prefix: '/superadmin-stale-context-test',
                                context: {
                                    headers: request.headers,
                                    db: prisma,
                                    logger,
                                },
                            });
                            return (
                                result.response ??
                                new Response(null, { status: 404 })
                            );
                        },
                    })
                );
                const before = await auditIds();
                const slug = `sa-tx-stale-${id}`;
                try {
                    await assert.rejects(
                        stale.create({
                            name: 'Stale actor must not create',
                            slug,
                        }),
                        { code: 'FORBIDDEN' }
                    );
                    assert.equal(
                        admitted,
                        true,
                        'The native superadmin middleware must admit before the controlled revocation.'
                    );
                    assert.equal(
                        await prisma.organization.count({ where: { slug } }),
                        0
                    );
                    assert.deepEqual(await auditIds(), before);
                } finally {
                    await prisma.user.update({
                        where: { id: actor.user.id },
                        data: { isSuperAdmin: true },
                    });
                }
            }
        );
    } finally {
        await database.end();
    }
}
