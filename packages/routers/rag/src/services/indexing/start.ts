import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import { verifyEmbeddingModel } from '@repo/embeddings';
import { STRUCTURE_CHUNKER_VERSION } from '@repo/chunking';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { ragActor, requireCollection } from '../access';
import { audit } from '../mutation';
import {
    assertM3Profile,
    boundEmbeddingConfiguration,
} from './embedding-profile';
import {
    prepareVectorDestination,
    bindVectorDestination,
} from './generation-adapter';
import { stageInitialSnapshot, type DocumentSnapshot } from './changes';
import { safeIndexError, indexError } from './errors';
import { MAX_INDEXED_DOCUMENTS_PER_COLLECTION } from './limits';
import { validateMetadata } from './metadata-validation';

const manage = { ragCollection: ['manageDocuments'] };

/**
 * Probe provider/vector capabilities outside transactions, then atomically accept
 * one immutable first-generation snapshot and its exact source holds. A replay
 * returns the accepted generation without repeating external calls.
 */
export async function startIndex(
    context: AuthorizedContext,
    input: { collectionId: string; expectedRevision: number; requestId: string }
) {
    try {
        const actor = await ragActor(context, context.db, manage, true);
        const collection = await requireCollection(
            context.db,
            actor,
            input.collectionId,
            'manageDocuments'
        );
        const existing = await context.db.indexGeneration.findUnique({
            where: {
                ['organizationId_requestId']: {
                    organizationId: actor.organizationId,
                    requestId: input.requestId,
                },
            },
        });
        if (existing) {
            if (
                existing.collectionId !== collection.id ||
                existing.configurationRevision !== input.expectedRevision
            )
                throw indexError('PROFILE_UNSUPPORTED');
            return { generationId: existing.id };
        }
        if (collection.configurationRevision !== input.expectedRevision)
            throw indexError('PROFILE_UNSUPPORTED');
        const profile =
            await context.db.collectionConfigRevision.findUniqueOrThrow({
                where: {
                    ['organizationId_collectionId_revision']: {
                        organizationId: actor.organizationId,
                        collectionId: collection.id,
                        revision: input.expectedRevision,
                    },
                },
            });
        assertM3Profile(profile);
        const configuration = await boundEmbeddingConfiguration(
            context.db,
            actor.organizationId,
            collection.id,
            input.expectedRevision
        );
        const [identity, destination] = await Promise.all([
            verifyEmbeddingModel(configuration, {
                model: profile.model,
                dimensions: profile.dimensions,
                preset:
                    profile.embeddingPreset === 'EMBEDDING_GEMMA'
                        ? 'EMBEDDING_GEMMA'
                        : 'GENERIC',
                preparation: profile.preparation,
            }),
            prepareVectorDestination(
                context.db,
                actor.organizationId,
                profile.vectorConnectionId
            ),
        ]);
        return await runSerializableTransaction(
            context.db,
            async (tx) => {
                const currentActor = await ragActor(context, tx, manage, true);
                const current = await requireCollection(
                    tx,
                    currentActor,
                    input.collectionId,
                    'manageDocuments'
                );
                // Even an increment of zero takes the collection row write lock, the
                // same fence used by attach/publish/metadata/delete event acceptance.
                const locked = await tx.collection.update({
                    where: { id: current.id },
                    data: { contentSequence: { increment: 0 } },
                });
                const replay = await tx.indexGeneration.findUnique({
                    where: {
                        ['organizationId_requestId']: {
                            organizationId: currentActor.organizationId,
                            requestId: input.requestId,
                        },
                    },
                });
                if (replay) {
                    if (
                        replay.collectionId !== current.id ||
                        replay.configurationRevision !== input.expectedRevision
                    )
                        throw indexError('PROFILE_UNSUPPORTED');
                    return { generationId: replay.id };
                }
                if (locked.configurationRevision !== input.expectedRevision)
                    throw indexError('PROFILE_UNSUPPORTED');
                if (
                    await tx.indexGeneration.count({
                        where: {
                            organizationId: currentActor.organizationId,
                            collectionId: current.id,
                            status: { not: 'CLEANED' },
                        },
                    })
                )
                    throw new ORPCError('CONFLICT', {
                        message:
                            'Retry the existing index. Rebuilding an existing collection is a later milestone.',
                    });
                await boundEmbeddingConfiguration(
                    tx,
                    currentActor.organizationId,
                    current.id,
                    input.expectedRevision
                );
                await bindVectorDestination(tx, destination);
                const associations = await tx.collectionDocument.findMany({
                    where: {
                        organizationId: currentActor.organizationId,
                        collectionId: current.id,
                        document: { deletedAt: null },
                    },
                    orderBy: { documentId: 'asc' },
                    take: MAX_INDEXED_DOCUMENTS_PER_COLLECTION + 1,
                    include: {
                        document: {
                            include: {
                                versions: {
                                    where: {
                                        status: 'READY',
                                        contentState: 'AVAILABLE',
                                        discardedAt: null,
                                        extraction: { discardedAt: null },
                                    },
                                    orderBy: { version: 'desc' },
                                    take: 1,
                                    include: { extraction: true },
                                },
                            },
                        },
                    },
                });
                if (associations.length > MAX_INDEXED_DOCUMENTS_PER_COLLECTION)
                    throw indexError('QUOTA_EXCEEDED');
                const documents: DocumentSnapshot[] = [];
                for (const association of associations) {
                    const version = association.document.versions[0];
                    if (!version?.extraction)
                        throw indexError('SOURCE_UNAVAILABLE');
                    documents.push({
                        association: {
                            ...association,
                            metadata: validateMetadata(
                                profile.metadataFields,
                                association.metadata
                            ),
                        },
                        document: association.document,
                        version: { ...version, extraction: version.extraction },
                    });
                }
                const id = randomUUID();
                const generation = await tx.indexGeneration.create({
                    data: {
                        id,
                        organizationId: currentActor.organizationId,
                        collectionId: current.id,
                        requestId: input.requestId,
                        configurationRevision: input.expectedRevision,
                        vectorConnectionId: profile.vectorConnectionId,
                        vectorSchema: destination.schema,
                        tableName: `g_${id.replaceAll('-', '')}`,
                        destinationFingerprint:
                            destination.destinationFingerprint,
                        modelIdentity: identity.digest,
                        capabilitySnapshot: identity,
                        chunkerVersion: STRUCTURE_CHUNKER_VERSION,
                        snapshotSequence: locked.contentSequence,
                        appliedSequence: locked.contentSequence,
                        createdBy: currentActor.userId,
                    },
                });
                await tx.collectionIndexAccounting.upsert({
                    where: { collectionId: current.id },
                    create: {
                        organizationId: currentActor.organizationId,
                        collectionId: current.id,
                    },
                    update: {},
                });
                await tx.indexTask.create({
                    data: {
                        organizationId: currentActor.organizationId,
                        collectionId: current.id,
                        generationId: id,
                        kind: 'PROVISION',
                        dedupeKey: `provision:${id}`,
                        requestedBy: currentActor.userId,
                    },
                });
                await stageInitialSnapshot(
                    tx,
                    generation,
                    documents,
                    currentActor.userId
                );
                await audit(
                    tx,
                    currentActor,
                    'collection.index.started',
                    current.id,
                    {
                        generationId: id,
                        documents: documents.length,
                        revision: input.expectedRevision,
                    }
                );
                return { generationId: id };
            },
            { timeout: 30_000, maxWait: 10_000 }
        );
    } catch (error) {
        throw safeIndexError(error);
    }
}
