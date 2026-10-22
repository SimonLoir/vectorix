import {
    discoverModels,
    verifyEmbeddingModel,
    embeddingPreset,
    embeddingIdentityKind,
} from '@repo/embeddings';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { ragActor, requireCollection } from '../access';
import {
    assertSupportedIndexProfile,
    boundEmbeddingConfiguration,
} from './embedding-profile';
import { safeIndexError, indexError } from './errors';

async function savedProfile(context: AuthorizedContext, collectionId: string) {
    const actor = await ragActor(
        context,
        context.db,
        { ragCollection: ['manageDocuments'] },
        true
    );
    const collection = await requireCollection(
        context.db,
        actor,
        collectionId,
        'manageDocuments'
    );
    const profile = await context.db.collectionConfigRevision.findUnique({
        where: {
            ['organizationId_collectionId_revision']: {
                organizationId: actor.organizationId,
                collectionId,
                revision: collection.configurationRevision,
            },
        },
    });
    if (!profile) throw indexError('PROFILE_UNSUPPORTED');
    assertSupportedIndexProfile(profile);
    return { actor, collection, profile };
}

/** Discovery uses the complete credential binding of the saved revision, with an operator-approved endpoint. */
export async function listEmbeddingModels(
    context: AuthorizedContext,
    collectionId: string,
    expectedRevision?: number
) {
    try {
        const { actor, profile } = await savedProfile(context, collectionId);
        if (
            expectedRevision !== undefined &&
            profile.revision !== expectedRevision
        )
            throw indexError('MODEL_CHANGED');
        const items = await discoverModels(
            await boundEmbeddingConfiguration(
                context.db,
                actor.organizationId,
                collectionId,
                profile.revision
            )
        );
        const latest = await savedProfile(context, collectionId);
        if (latest.profile.revision !== profile.revision)
            throw indexError('MODEL_CHANGED');
        return {
            items: items.slice(0, 100),
            discoverySource:
                profile.provider === 'COHERE'
                    ? ('HOSTED_CATALOG' as const)
                    : ('LOCAL_RUNTIME' as const),
        };
    } catch (error) {
        throw safeIndexError(error);
    }
}

/** Probe the actual native model/digest and dimensions without sending any organization document content. */
export async function probeEmbeddingModel(
    context: AuthorizedContext,
    input: {
        collectionId: string;
        expectedRevision: number;
    }
) {
    try {
        const { actor, collection, profile } = await savedProfile(
            context,
            input.collectionId
        );
        if (collection.configurationRevision !== input.expectedRevision)
            throw indexError('MODEL_CHANGED');
        const identity = await verifyEmbeddingModel(
            await boundEmbeddingConfiguration(
                context.db,
                actor.organizationId,
                input.collectionId,
                profile.revision
            ),
            {
                model: profile.model,
                dimensions: profile.dimensions,
                preset: embeddingPreset.parse(profile.embeddingPreset),
                preparation: profile.preparation,
            }
        );
        const latest = await savedProfile(context, input.collectionId);
        if (latest.collection.configurationRevision !== input.expectedRevision)
            throw indexError('MODEL_CHANGED');
        return {
            ...identity,
            identityKind: embeddingIdentityKind(identity),
            discoverySource:
                identity.provider === 'COHERE'
                    ? ('HOSTED_CATALOG' as const)
                    : ('LOCAL_RUNTIME' as const),
        };
    } catch (error) {
        throw safeIndexError(error);
    }
}
