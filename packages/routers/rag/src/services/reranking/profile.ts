import type { Prisma, CollectionRerankConfig } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { permits } from '@repo/auth/permissions';
import {
    listRerankingModels,
    type RerankingProvider,
} from '@repo/reranking/models';
import { rerankProfileView } from '@repo/api-contracts/v1/rag/reranking';
import { grantWhere, requireCollection } from '../access';
import { audit, mutate } from '../mutation';
import { indexCapabilities } from '../indexing/access';
import {
    currentRerankBinding,
    isRerankingProvider,
    RERANK_CAPABILITY_VERSION,
    supportsRerankConfiguration,
} from './configuration';
import { rerankError, safeRerankError } from './errors';

export type ConfigureRerankInput = Readonly<{
    collectionId: string;
    expectedRevision: number;
    enabled: boolean;
    provider: RerankingProvider;
    model: string;
    candidatePool: number;
}>;

/** The latest immutable revision is the current profile; absence is the explicit disabled revision zero. */
export function currentRerankProfile(
    db: Prisma.TransactionClient,
    organizationId: string,
    collectionId: string
) {
    return db.collectionRerankConfig.findFirst({
        where: { organizationId, collectionId },
        orderBy: { revision: 'desc' },
    });
}

function publicConfiguration(configuration: CollectionRerankConfig | null) {
    if (!configuration) return null;
    if (!isRerankingProvider(configuration.provider))
        throw rerankError('PROFILE_UNSUPPORTED');
    return {
        provider: configuration.provider,
        model: configuration.model,
        candidatePool: configuration.candidatePool,
        bindingSource: configuration.endpoint
            ? configuration.credentialId
                ? ('ORGANIZATION' as const)
                : ('PLATFORM' as const)
            : ('UNBOUND' as const),
        createdAt: configuration.createdAt,
    };
}

/** Metadata access does not grant reading or use; compute both independently without decrypting provider secrets. */
export async function getRerankProfile(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
): Promise<typeof rerankProfileView._output> {
    const capabilities = await indexCapabilities(context, collectionId, db);
    const { actor, collection } = capabilities;
    const configuration = await currentRerankProfile(
        db,
        actor.organizationId,
        collectionId
    );
    const canAdminister =
        permits(actor.permissions, { ragCollection: ['manageAll'] }) ||
        Boolean(
            await db.collection.findFirst({
                where: {
                    AND: [
                        { id: collectionId },
                        grantWhere(actor, 'administer'),
                    ],
                },
                select: { id: true },
            })
        );
    const canManage =
        !actor.keyId &&
        !collection.deletedAt &&
        permits(actor.permissions, { ragCollection: ['update'] }) &&
        canAdminister;
    const canUse =
        !collection.deletedAt &&
        capabilities.canRead &&
        permits(actor.permissions, { ragRerank: ['use'] }) &&
        Boolean(
            configuration?.enabled &&
            configuration.endpoint &&
            supportsRerankConfiguration(configuration)
        );
    return rerankProfileView.parse({
        revision: configuration?.revision ?? 0,
        enabled: configuration?.enabled ?? false,
        configuration: publicConfiguration(configuration),
        canManage,
        canUse,
    });
}

/** Append one revision with CAS, session authority, saved binding and audit in the same serializable transaction. */
export async function configureRerankProfile(
    context: AuthorizedContext,
    input: ConfigureRerankInput
) {
    try {
        return await mutate(
            context,
            { ragCollection: ['update'] },
            async (db, actor) => {
                const collection = await requireCollection(
                    db,
                    actor,
                    input.collectionId,
                    'administer'
                );
                // Share the existing write fence with deletion/rebuild/catalog changes.
                await db.collection.update({
                    where: { id: collection.id },
                    data: { contentSequence: { increment: 0 } },
                });
                const current = await currentRerankProfile(
                    db,
                    actor.organizationId,
                    collection.id
                );
                if ((current?.revision ?? 0) !== input.expectedRevision)
                    throw rerankError('RERANK_PROFILE_CHANGED');
                if (
                    (await db.collectionRerankConfig.count({
                        where: {
                            organizationId: actor.organizationId,
                            collectionId: collection.id,
                        },
                    })) >= 1000
                )
                    throw rerankError('RERANK_CAPACITY');
                if (
                    !listRerankingModels(input.provider).some(
                        (model) => model.id === input.model
                    )
                )
                    throw rerankError('MODEL_UNSUPPORTED');
                const binding = input.enabled
                    ? await currentRerankBinding(
                          db,
                          actor.organizationId,
                          input.provider
                      )
                    : {
                          credentialId: null,
                          credentialRevision: null,
                          endpoint: null,
                      };
                const revision = (current?.revision ?? 0) + 1;
                await db.collectionRerankConfig.create({
                    data: {
                        organizationId: actor.organizationId,
                        collectionId: collection.id,
                        revision,
                        enabled: input.enabled,
                        provider: input.provider,
                        model: input.model,
                        candidatePool: input.candidatePool,
                        capabilityVersion: RERANK_CAPABILITY_VERSION,
                        ...binding,
                    },
                });
                await audit(
                    db,
                    actor,
                    'collection.reranking.configure',
                    collection.id,
                    {
                        revision,
                        enabled: input.enabled,
                        provider: input.provider,
                        model: input.model,
                        candidatePool: input.candidatePool,
                    }
                );
                return getRerankProfile(context, collection.id, db);
            }
        );
    } catch (error) {
        throw safeRerankError(error);
    }
}
