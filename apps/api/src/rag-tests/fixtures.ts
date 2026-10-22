import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import type { VectorixApiV1Client } from '@repo/api';
import { prisma } from '@repo/db';
import { initializeVectorixPermissions } from '@repo/auth/permissions/rollout';
import { app } from '../app';

if (
    !new URL(
        process.env.DATABASE_URL ?? 'postgresql://localhost/'
    ).pathname.endsWith('_test')
)
    throw new Error(
        'RAG integration tests require an isolated DATABASE_URL ending in _test.'
    );

export function rpc(
    headers: () => Record<string, string>
): VectorixApiV1Client {
    return createORPCClient(
        new RPCLink({
            url: 'http://localhost:3001/rpc/v1',
            headers,
            fetch: (request) => Promise.resolve(app.request(request)),
        })
    );
}

function browser() {
    const cookies = new Map<string, string>();
    const headers = () => ({
        origin: 'http://localhost:3000',
        cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
    });
    const client = rpc(headers);
    async function post(path: string, body: unknown) {
        const response = await app.request(
            `http://localhost:3001/api/auth/${path}`,
            {
                method: 'POST',
                headers: { ...headers(), 'content-type': 'application/json' },
                body: JSON.stringify(body),
            }
        );
        for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0]!;
            const index = pair.indexOf('=');
            cookies.set(pair.slice(0, index), pair.slice(index + 1));
        }
        const result = await response.json();
        assert.ok(response.ok, `${path}: ${JSON.stringify(result)}`);
        return result;
    }
    return { client, rag: client.admin.rag, post, headers };
}

export const fixture = {
    owner: browser(),
    other: browser(),
    reader: browser(),
    manager: browser(),
    org: '',
    otherOrg: '',
    ownerMember: '',
    otherMember: '',
    readerMember: '',
    managerMember: '',
    users: [] as string[],
};
export const profile = {
    provider: 'OLLAMA' as const,
    model: 'test-embedding',
    dimensions: 768,
};
export const readGrant = {
    read: true,
    manageDocuments: false,
    administer: false,
};

/** Exercise real sign-in and organization cookies; add test members directly without sending invitations. */
export async function setup() {
    await initializeVectorixPermissions();
    process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT =
        'http://platform-ollama.test:11434';
    process.env.VECTORIX_DEFAULT_OLLAMA_API_KEY = '';
    const run = randomUUID();
    for (const [index, session] of [
        fixture.owner,
        fixture.other,
        fixture.reader,
        fixture.manager,
    ].entries()) {
        const user = await session.post('sign-up/email', {
            name: `RAG ${index}`,
            email: `rag-${run}-${index}@example.test`,
            password: 'Catalog-test-password-928!',
        });
        const userId: unknown = user.user.id;
        assert.ok(typeof userId === 'string');
        fixture.users.push(userId);
    }
    for (const [index, session] of [fixture.owner, fixture.other].entries()) {
        const org = await session.post('organization/create', {
            name: `RAG ${index}`,
            slug: `rag-${run}-${index}`,
        });
        await session.post('organization/set-active', {
            organizationId: org.id,
        });
        const member = await session.client.admin.members.me({});
        if (index === 0) {
            fixture.org = org.id;
            fixture.ownerMember = member.id;
        } else {
            fixture.otherOrg = org.id;
            fixture.otherMember = member.id;
        }
    }
    for (const [index, session] of [
        fixture.reader,
        fixture.manager,
    ].entries()) {
        const member = await prisma.member.create({
            data: {
                id: randomUUID(),
                organizationId: fixture.org,
                userId: fixture.users[index + 2]!,
                role: index === 0 ? 'member' : 'admin',
                createdAt: new Date(),
            },
        });
        if (index === 0) fixture.readerMember = member.id;
        else fixture.managerMember = member.id;
        await session.post('organization/set-active', {
            organizationId: fixture.org,
        });
    }
}

/**
 * The catalog runner owns and destroys this database and S3 container after the
 * suite. Retained fixtures include intentionally unavailable historical storage
 * endpoints, so teardown never fabricates a successful purge to bypass guards.
 * Clean-organization cascades are covered by the dedicated source-hold journey.
 */
export async function cleanup() {
    await prisma.$disconnect();
}
