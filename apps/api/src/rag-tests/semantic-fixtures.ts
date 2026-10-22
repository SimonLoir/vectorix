import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prisma, type IndexTask } from '@repo/db';
import { fixture as f } from './fixtures';
import { createIndexingFixture } from './indexing-fixtures';

export const semanticSizes = {
    targetTokens: 48,
    minTokens: 16,
    maxTokens: 64,
    overlapTokens: 4,
    semanticPercentile: 75,
    parentMaxTokens: 2048,
};
export const semanticProfile = {
    provider: 'OLLAMA' as const,
    model: 'fixture:latest',
    dimensions: 3,
    chunkingStrategy: 'SEMANTIC' as const,
    parentChild: false,
    chunking: semanticSizes,
};
export const semanticText = (sentences = 12) =>
    Array.from({ length: sentences }, (_, index) =>
        index % 2
            ? `Solar energy shelters the forest and its animals in passage ${index}.`
            : `Les renards protègent la forêt et le café français au passage ${index}.`
    ).join('\n');

/** Each journey owns a fresh catalog organization; fixture teardown never fabricates physical cleanup. */
export async function createSemanticFixture(label: string, members = false) {
    const previous = {
        org: f.org,
        ownerMember: f.ownerMember,
        readerMember: f.readerMember,
        managerMember: f.managerMember,
    };
    const organization: unknown = await f.owner.post('organization/create', {
        name: `Semantic ${label} ${randomUUID()}`,
        slug: `semantic-${randomUUID()}`,
    });
    assert(
        organization &&
            typeof organization === 'object' &&
            'id' in organization &&
            typeof organization.id === 'string'
    );
    f.org = organization.id;
    await f.owner.post('organization/set-active', { organizationId: f.org });
    f.ownerMember = (await f.owner.client.admin.members.me({})).id;
    if (members) {
        for (const [index, session] of [f.reader, f.manager].entries()) {
            const member = await prisma.member.create({
                data: {
                    id: randomUUID(),
                    organizationId: f.org,
                    userId: f.users[index + 2]!,
                    role: index ? 'admin' : 'member',
                    createdAt: new Date(),
                },
            });
            if (index) f.managerMember = member.id;
            else f.readerMember = member.id;
            await session.post('organization/set-active', {
                organizationId: f.org,
            });
        }
    }
    const indexing = await createIndexingFixture();
    return {
        ...indexing,
        organizationId: f.org,
        collection(name = label) {
            return f.owner.rag.collections.create({
                name,
                grantCreatorRead: true,
                profile: semanticProfile,
            });
        },
        async close() {
            try {
                await indexing.close();
            } finally {
                f.org = previous.org;
                f.ownerMember = previous.ownerMember;
                f.readerMember = previous.readerMember;
                f.managerMember = previous.managerMember;
                await f.owner.post('organization/set-active', {
                    organizationId: f.org,
                });
                if (members)
                    for (const session of [f.reader, f.manager])
                        await session.post('organization/set-active', {
                            organizationId: f.org,
                        });
            }
        },
    };
}
export type SemanticFixture = Awaited<ReturnType<typeof createSemanticFixture>>;

/** Advance only owned pending queue deadlines; real processors retain their leases, authorization and state transitions. */
export async function scanSemantic(
    fixture: SemanticFixture,
    generationId: string,
    passes = 4
) {
    for (let pass = 0; pass < passes; pass++) {
        await prisma.indexTask.updateMany({
            where: {
                organizationId: fixture.organizationId,
                generationId,
                status: 'PENDING',
            },
            data: { availableAt: new Date(0) },
        });
        await fixture.scan(1);
    }
}
export async function candidateTask(
    generationId: string,
    documentId?: string
): Promise<IndexTask> {
    return await prisma.indexTask.findFirstOrThrow({
        where: {
            generationId,
            kind: 'INDEX_DOCUMENT',
            ...(documentId ? { indexedDocument: { is: { documentId } } } : {}),
        },
    });
}

/** A missing controlled request fails in five seconds and every test releases the response in finally. */
export function semanticLatch() {
    let release: () => void = () => {};
    let arrive: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
        arrive = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    return {
        release,
        async block() {
            arrive();
            await blocked;
        },
        async arrived() {
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    waiting,
                    new Promise<never>((_resolve, reject) => {
                        timer = setTimeout(
                            () =>
                                reject(
                                    new Error(
                                        'Controlled semantic embedding did not arrive.'
                                    )
                                ),
                            5000
                        );
                    }),
                ]);
            } finally {
                clearTimeout(timer);
            }
        },
    };
}
