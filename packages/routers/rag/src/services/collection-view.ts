import type { Prisma, Collection } from '@repo/db';
import { ORPCError } from '@orpc/server';
import { permits } from '@repo/auth/permissions';
import { collectionView } from '@repo/api-contracts/v1/rag/collections';
import { grantWhere, type RagActor } from './access';

/** Return configuration metadata and explicit effective grants without endpoints or provider secrets. */
export async function collectionDto(
    db: Prisma.TransactionClient,
    actor: RagActor,
    collection: Collection
) {
    const configuration = await db.collectionConfigRevision.findUnique({
        where: {
            ['organizationId_collectionId_revision']: {
                organizationId: actor.organizationId,
                collectionId: collection.id,
                revision: collection.configurationRevision,
            },
        },
    });
    if (!configuration)
        throw new ORPCError('CONFLICT', {
            message: 'Collection configuration is missing.',
        });
    const has = async (action: 'read' | 'manageDocuments' | 'administer') => {
        const required = action === 'administer' ? 'update' : action;
        return (
            permits(actor.permissions, { ragCollection: [required] }) &&
            Boolean(
                await db.collection.findFirst({
                    where: {
                        AND: [{ id: collection.id }, grantWhere(actor, action)],
                    },
                    select: { id: true },
                })
            )
        );
    };
    const [read, manageDocuments, administer] = await Promise.all([
        has('read'),
        has('manageDocuments'),
        has('administer'),
    ]);
    const {
        provider,
        model,
        dimensions,
        metric,
        indexType,
        numericType,
        preparation,
        chunkingStrategy,
        chunking,
        parentChild,
        vectorConnectionId,
        credentialId,
        credentialRevision,
    } = configuration;
    return collectionView.parse({
        ...collection,
        permissions: {
            read,
            manageDocuments,
            administer:
                administer ||
                (!actor.keyId &&
                    permits(actor.permissions, {
                        ragCollection: ['manageAll'],
                    })),
        },
        configuration: {
            provider,
            model,
            dimensions,
            metric,
            indexType,
            numericType,
            preparation,
            chunkingStrategy,
            chunking,
            parentChild,
            vectorConnectionId,
            credentialId,
            credentialRevision,
        },
    });
}
