import { randomUUID } from 'node:crypto';
import type { Prisma, Collection } from '@repo/db';
import { verifyEmbeddingModel } from '@repo/embeddings';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { runSerializableTransaction } from '@routers/utils/transactions';
import { ragActor, requireCollection, type RagActor } from '../access';
import { audit } from '../mutation';
import { requireIndexRebuild } from './access';
import { boundEmbeddingConfiguration } from './embedding-profile';
import { resolveIndexChunking } from './generation-profile';
import {
    prepareVectorDestination,
    bindVectorDestination,
} from './generation-adapter';
import { stageInitialSnapshot, type DocumentSnapshot } from './changes';
import { safeIndexError, indexError } from './errors';
import { MAX_INDEXED_DOCUMENTS_PER_COLLECTION } from './limits';
import { projectMetadata } from './metadata-validation';

export interface FirstIndexInput {
    collectionId: string;
    expectedRevision: number;
    requestId: string;
}
export interface RebuildIndexInput extends FirstIndexInput {
    expectedActiveGenerationId: string;
}

/** Serialize admission with a non-key row write, compatible with descendant KEY SHARE guards; the predicate never reactivates a suspended organization. */
export async function lockGenerationAdmission(
    tx: Prisma.TransactionClient,
    organizationId: string
) {
    const locked = await tx.organization.updateMany({
        where: { id: organizationId, isActive: true },
        data: { isActive: true },
    });
    if (!locked.count) throw indexError('ACCESS_REVOKED', 'FORBIDDEN');
}

async function authorize(
    context: AuthorizedContext,
    input: FirstIndexInput,
    rebuild: boolean,
    db: Prisma.TransactionClient = context.db
) {
    if (rebuild) return requireIndexRebuild(context, input.collectionId, db);
    const actor = await ragActor(
        context,
        db,
        { ragCollection: ['manageDocuments'] },
        true
    );
    const collection = await requireCollection(
        db,
        actor,
        input.collectionId,
        'manageDocuments'
    );
    return { actor, collection };
}

async function replay(
    tx: Prisma.TransactionClient,
    actor: RagActor,
    input: FirstIndexInput | RebuildIndexInput
) {
    const accepted = await tx.indexGeneration.findUnique({
        where: {
            ['organizationId_requestId']: {
                organizationId: actor.organizationId,
                requestId: input.requestId,
            },
        },
    });
    if (!accepted) return null;
    const predecessor =
        'expectedActiveGenerationId' in input
            ? input.expectedActiveGenerationId
            : null;
    if (
        accepted.collectionId !== input.collectionId ||
        accepted.configurationRevision !== input.expectedRevision ||
        accepted.previousGenerationId !== predecessor
    )
        throw indexError('GENERATION_CONFLICT');
    return { generationId: accepted.id };
}

/** The organization lock and collection fence must already be held before this admission decision. */
async function assertGenerationAdmission(
    tx: Prisma.TransactionClient,
    collection: Collection,
    input: FirstIndexInput | RebuildIndexInput
) {
    const rebuild = 'expectedActiveGenerationId' in input;
    if (
        collection.configurationRevision !== input.expectedRevision ||
        collection.deletedAt
    )
        throw indexError(
            rebuild ? 'GENERATION_CONFLICT' : 'PROFILE_UNSUPPORTED'
        );
    const retained = await tx.indexGeneration.count({
        where: {
            organizationId: collection.organizationId,
            collectionId: collection.id,
            status: { not: 'CLEANED' },
        },
    });
    if (!rebuild) {
        if (collection.activeGenerationId || retained)
            throw indexError('GENERATION_CONFLICT');
        return;
    }
    if (collection.activeGenerationId !== input.expectedActiveGenerationId)
        throw indexError('GENERATION_CONFLICT');
    const previous = await tx.indexGeneration.findFirst({
        where: {
            organizationId: collection.organizationId,
            collectionId: collection.id,
            id: input.expectedActiveGenerationId,
            status: 'ACTIVE',
        },
    });
    if (!previous) throw indexError('GENERATION_CONFLICT');
    if (
        retained >= 2 ||
        (await tx.indexGeneration.count({
            where: {
                organizationId: collection.organizationId,
                previousGenerationId: { not: null },
                status: { in: ['PROVISIONING', 'BUILDING', 'FAILED'] },
            },
        }))
    )
        throw indexError('REBUILD_IN_PROGRESS');
}

/**
 * Share provider probing and immutable snapshot acceptance while preserving the
 * old first-index operation's first-only authorization and behavior. All external
 * I/O precedes the short organization/collection-fenced acceptance transaction.
 */
export async function acceptIndexGeneration(
    context: AuthorizedContext,
    input: FirstIndexInput | RebuildIndexInput
) {
    const rebuild = 'expectedActiveGenerationId' in input;
    try {
        const { actor, collection } = await authorize(context, input, rebuild);
        const existing = await replay(context.db, actor, input);
        if (existing) return existing;
        if (
            collection.configurationRevision !== input.expectedRevision ||
            (rebuild &&
                collection.activeGenerationId !==
                    input.expectedActiveGenerationId)
        )
            throw indexError(
                rebuild ? 'GENERATION_CONFLICT' : 'PROFILE_UNSUPPORTED'
            );
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
        const chunker = resolveIndexChunking(profile);
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
                await lockGenerationAdmission(tx, actor.organizationId);
                const currentActor = (
                    await authorize(context, input, rebuild, tx)
                ).actor;
                const locked = await tx.collection.update({
                    where: {
                        ['organizationId_id']: {
                            organizationId: currentActor.organizationId,
                            id: input.collectionId,
                        },
                    },
                    data: { contentSequence: { increment: 0 } },
                });
                const accepted = await replay(tx, currentActor, input);
                if (accepted) return accepted;
                await assertGenerationAdmission(tx, locked, input);
                await boundEmbeddingConfiguration(
                    tx,
                    currentActor.organizationId,
                    locked.id,
                    input.expectedRevision
                );
                await bindVectorDestination(tx, destination);
                const associations = await tx.collectionDocument.findMany({
                    where: {
                        organizationId: currentActor.organizationId,
                        collectionId: locked.id,
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
                    let metadata;
                    try {
                        metadata = projectMetadata(
                            profile.metadataFields,
                            association.metadata
                        );
                    } catch {
                        throw indexError('METADATA_INCOMPATIBLE');
                    }
                    documents.push({
                        association: { ...association, metadata },
                        document: association.document,
                        version: { ...version, extraction: version.extraction },
                    });
                }
                const id = randomUUID();
                const generation = await tx.indexGeneration.create({
                    data: {
                        id,
                        organizationId: currentActor.organizationId,
                        collectionId: locked.id,
                        requestId: input.requestId,
                        configurationRevision: input.expectedRevision,
                        previousGenerationId: rebuild
                            ? input.expectedActiveGenerationId
                            : null,
                        authorityUserId: rebuild ? currentActor.userId : null,
                        vectorConnectionId: profile.vectorConnectionId,
                        vectorSchema: destination.schema,
                        tableName: `g_${id.replaceAll('-', '')}`,
                        destinationFingerprint:
                            destination.destinationFingerprint,
                        modelIdentity: identity.digest,
                        capabilitySnapshot: identity,
                        chunkerVersion: chunker.version,
                        parentContextVersion: chunker.parentContextVersion,
                        snapshotSequence: locked.contentSequence,
                        appliedSequence: locked.contentSequence,
                        createdBy: currentActor.userId,
                    },
                });
                await tx.collectionIndexAccounting.upsert({
                    where: { collectionId: locked.id },
                    create: {
                        organizationId: currentActor.organizationId,
                        collectionId: locked.id,
                    },
                    update: {},
                });
                await tx.indexTask.create({
                    data: {
                        organizationId: currentActor.organizationId,
                        collectionId: locked.id,
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
                    rebuild
                        ? 'collection.index.rebuild.started'
                        : 'collection.index.started',
                    locked.id,
                    {
                        generationId: id,
                        documents: documents.length,
                        revision: input.expectedRevision,
                        ...(rebuild
                            ? {
                                  previousGenerationId:
                                      input.expectedActiveGenerationId,
                              }
                            : {}),
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
