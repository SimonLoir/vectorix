import { randomUUID } from 'node:crypto';
import type { Prisma } from '@repo/db';
import type { z } from 'zod';
import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { encrypt } from '@routers/utils/encryption';
import { rerankEndpointsContract } from '@repo/api-contracts/v1/rag/reranking-extended';
import { ragActor } from '../access';
import { audit, mutate } from '../mutation';
import {
    rerankEndpointDto,
    rerankEndpointSecretContext,
    validateRerankEndpointKey,
} from './endpoint-data';
import {
    assertRerankingEndpoint,
    normalizeRerankingEndpoint,
} from './endpoint-policy';
import { rerankError } from './errors';

type EndpointCreate = z.output<
    NonNullable<(typeof rerankEndpointsContract.create)['~orpc']['inputSchema']>
>;
type EndpointUpdate = z.output<
    NonNullable<(typeof rerankEndpointsContract.update)['~orpc']['inputSchema']>
>;
type EndpointTarget = { id: string; expectedRevision: number };

/** Current session and credentials grants precede all metadata access. Pagination/filtering stays in PostgreSQL. */
export async function listRerankEndpoints(
    context: AuthorizedContext,
    input: { query: string; offset: number; limit: number }
) {
    const actor = await ragActor(
        context,
        context.db,
        { ragCredentials: ['read'] },
        true
    );
    const where = {
        organizationId: actor.organizationId,
        name: { contains: input.query, mode: 'insensitive' as const },
    };
    const [items, total] = await Promise.all([
        context.db.rerankEndpointCredential.findMany({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            skip: input.offset,
            take: input.limit,
        }),
        context.db.rerankEndpointCredential.count({ where }),
    ]);
    return { items: items.map(rerankEndpointDto), total };
}

/** Organization fencing serializes bounded inventory and the partial-unique active selection. */
async function lockEndpointInventory(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    await db.organizationRerankAccounting.upsert({
        where: { organizationId },
        create: { organizationId },
        update: { lockRevision: { increment: 1n } },
    });
}

async function currentEndpoint(
    db: Prisma.TransactionClient,
    organizationId: string,
    input: EndpointTarget
) {
    const row = await db.rerankEndpointCredential.findFirst({
        where: { id: input.id, organizationId },
    });
    if (!row) throw new ORPCError('NOT_FOUND');
    if (row.revision !== input.expectedRevision)
        throw new ORPCError('CONFLICT');
    return row;
}

/** Only an explicitly activated new row becomes the source for future profiles. No network occurs. */
export function createRerankEndpoint(
    context: AuthorizedContext,
    input: EndpointCreate
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            if (input.provider !== 'TEI')
                throw rerankError('PROFILE_UNSUPPORTED');
            const endpoint = normalizeRerankingEndpoint(input.endpoint);
            assertRerankingEndpoint('TEI', endpoint);
            await lockEndpointInventory(db, actor.organizationId);
            if (
                (await db.rerankEndpointCredential.count({
                    where: { organizationId: actor.organizationId },
                })) >= 50
            )
                throw new ORPCError('CONFLICT');
            const apiKey = validateRerankEndpointKey(input.apiKey);
            const id = randomUUID();
            if (input.activate)
                await db.rerankEndpointCredential.updateMany({
                    where: {
                        organizationId: actor.organizationId,
                        provider: 'TEI',
                        active: true,
                    },
                    data: { active: false },
                });
            const row = await db.rerankEndpointCredential.create({
                data: {
                    id,
                    organizationId: actor.organizationId,
                    provider: 'TEI',
                    name: input.name,
                    endpoint,
                    apiKey:
                        apiKey === null
                            ? null
                            : await encrypt(
                                  apiKey,
                                  rerankEndpointSecretContext(
                                      actor.organizationId,
                                      id
                                  )
                              ),
                    active: input.activate,
                },
            });
            await audit(db, actor, 'reranking.endpoint.create', row.id, {
                provider: row.provider,
                active: row.active,
            });
            return rerankEndpointDto(row);
        }
    );
}

/** Omitted keys preserve ciphertext; null explicitly clears it. Referenced destinations cannot move. */
export function updateRerankEndpoint(
    context: AuthorizedContext,
    input: EndpointUpdate
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            await lockEndpointInventory(db, actor.organizationId);
            const current = await currentEndpoint(
                db,
                actor.organizationId,
                input
            );
            const endpoint = normalizeRerankingEndpoint(input.endpoint);
            assertRerankingEndpoint('TEI', endpoint);
            if (input.apiKey !== undefined)
                validateRerankEndpointKey(input.apiKey);
            const moved = current.endpoint !== endpoint;
            if (
                moved &&
                (await db.collectionRerankConfig.count({
                    where: {
                        organizationId: actor.organizationId,
                        selfHostedCredentialId: current.id,
                    },
                }))
            )
                throw new ORPCError('CONFLICT');
            if (moved && current.apiKey !== null && input.apiKey === undefined)
                throw new ORPCError('BAD_REQUEST');
            const row = await db.rerankEndpointCredential.update({
                where: { id: current.id },
                data: {
                    name: input.name,
                    endpoint,
                    revision: { increment: 1 },
                    ...(input.apiKey === undefined
                        ? {}
                        : {
                              apiKey:
                                  input.apiKey === null
                                      ? null
                                      : await encrypt(
                                            input.apiKey,
                                            rerankEndpointSecretContext(
                                                actor.organizationId,
                                                current.id
                                            )
                                        ),
                          }),
                },
            });
            await audit(db, actor, 'reranking.endpoint.update', row.id, {
                revision: row.revision,
                destinationChanged: moved,
            });
            return rerankEndpointDto(row);
        }
    );
}

/** Activation affects future profile binding only; retained immutable profiles keep their exact destination. */
export function activateRerankEndpoint(
    context: AuthorizedContext,
    input: EndpointTarget
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            await lockEndpointInventory(db, actor.organizationId);
            const row = await currentEndpoint(db, actor.organizationId, input);
            if (row.provider !== 'TEI')
                throw rerankError('PROFILE_UNSUPPORTED');
            assertRerankingEndpoint('TEI', row.endpoint);
            await db.rerankEndpointCredential.updateMany({
                where: {
                    organizationId: actor.organizationId,
                    provider: row.provider,
                    active: true,
                },
                data: { active: false },
            });
            await db.rerankEndpointCredential.update({
                where: { id: row.id },
                data: { active: true },
            });
            await audit(db, actor, 'reranking.endpoint.activate', row.id, {
                provider: row.provider,
            });
            return { success: true as const };
        }
    );
}

/** A retained profile blocks deletion; the deferred FK also protects concurrent configuration/deletion. */
export function removeRerankEndpoint(
    context: AuthorizedContext,
    input: EndpointTarget
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            await lockEndpointInventory(db, actor.organizationId);
            const row = await currentEndpoint(db, actor.organizationId, input);
            if (
                await db.collectionRerankConfig.count({
                    where: {
                        organizationId: actor.organizationId,
                        selfHostedCredentialId: row.id,
                    },
                })
            )
                throw new ORPCError('CONFLICT');
            await db.rerankEndpointCredential.delete({ where: { id: row.id } });
            await audit(db, actor, 'reranking.endpoint.delete', row.id, {
                provider: row.provider,
            });
            return { success: true as const };
        }
    );
}
