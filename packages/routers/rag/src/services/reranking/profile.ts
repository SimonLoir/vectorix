import { Prisma, type CollectionRerankConfig } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { permits } from '@repo/auth/permissions';
import { supportsRerankingModel } from '@repo/reranking/models';
import {
    parseTeiRuntimeSnapshot,
    probeTei,
    type TeiRuntimeSnapshot,
} from '@repo/reranking';
import { rerankProfileView } from '@repo/api-contracts/v1/rag/reranking';
import {
    extendedRerankProfile,
    type configureExtendedRerankInput,
} from '@repo/api-contracts/v1/rag/reranking-extended';
import { grantWhere, requireCollection } from '../access';
import { audit, mutate } from '../mutation';
import { indexCapabilities } from '../indexing/access';
import {
    currentRerankBinding,
    isHostedRerankingProvider,
    isRerankingProvider,
    RERANK_CAPABILITY_VERSION,
    TEI_CAPABILITY_VERSION,
    supportsRerankConfiguration,
} from './configuration';
import { resolveRerankEndpoint } from './endpoint-data';
import { rerankError, safeRerankError } from './errors';

export type ConfigureRerankInput = typeof configureExtendedRerankInput._output;

/** The latest immutable revision is current; absence is explicitly disabled revision zero. */
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
            ? configuration.credentialId || configuration.selfHostedCredentialId
                ? ('ORGANIZATION' as const)
                : ('PLATFORM' as const)
            : ('UNBOUND' as const),
        createdAt: configuration.createdAt,
        runtimeSnapshot:
            configuration.provider === 'TEI' &&
            configuration.runtimeSnapshot !== null
                ? parseTeiRuntimeSnapshot(configuration.runtimeSnapshot)
                : null,
    };
}

/** Metadata access, collection use and session-only management remain independent capabilities. */
export async function getExtendedRerankProfile(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
): Promise<typeof extendedRerankProfile._output> {
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
    return extendedRerankProfile.parse({
        revision: configuration?.revision ?? 0,
        enabled: configuration?.enabled ?? false,
        configuration: publicConfiguration(configuration),
        canManage,
        canUse,
    });
}

/** Revision-22 clients never receive an unknown nested provider or a fabricated hosted projection. */
export async function getRerankProfile(
    context: AuthorizedContext,
    collectionId: string,
    db: Prisma.TransactionClient = context.db
): Promise<typeof rerankProfileView._output> {
    const profile = await getExtendedRerankProfile(context, collectionId, db);
    if (
        profile.configuration &&
        !isHostedRerankingProvider(profile.configuration.provider)
    )
        throw rerankError('PROFILE_UNSUPPORTED');
    return rerankProfileView.parse(profile);
}

type PreparedRuntime = {
    snapshot: TeiRuntimeSnapshot;
    binding: Awaited<ReturnType<typeof currentRerankBinding>>;
};

/** Probe outside transactions, only after authoritative session/collection checks. Save is explicit metadata I/O, never inference. */
async function prepareTeiRuntime(
    context: AuthorizedContext,
    input: ConfigureRerankInput
): Promise<PreparedRuntime | null> {
    if (input.provider !== 'TEI' || !input.enabled) return null;
    const resolved = await resolveRerankEndpoint(
        context.db,
        context.organizationId
    );
    const binding = {
        credentialId: null,
        selfHostedCredentialId: resolved.selfHostedCredentialId,
        credentialRevision: resolved.credentialRevision,
        endpoint: resolved.data.endpoint,
    };
    await context.admitProviderRequest?.();
    const snapshot = await probeTei(resolved.data, {
        model: input.model,
        candidatePool: input.candidatePool,
    });
    return { binding, snapshot };
}

/** Append one CAS revision with atomic audit; retry callbacks never contain provider I/O. */
async function configureProfile(
    context: AuthorizedContext,
    input: ConfigureRerankInput,
    extended: boolean
) {
    try {
        const access = await getExtendedRerankProfile(
            context,
            input.collectionId
        );
        if (!access.canManage) throw rerankError('ACCESS_REVOKED');
        if (
            !extended &&
            access.configuration &&
            !isHostedRerankingProvider(access.configuration.provider)
        )
            throw rerankError('PROFILE_UNSUPPORTED');
        if (
            !isRerankingProvider(input.provider) ||
            (!extended && !isHostedRerankingProvider(input.provider)) ||
            !supportsRerankingModel(input.provider, input.model)
        )
            throw rerankError('MODEL_UNSUPPORTED');
        const provider = input.provider;
        // Reject known stale saves before metadata I/O; the transaction below rechecks after it.
        if (access.revision !== input.expectedRevision)
            throw rerankError('RERANK_PROFILE_CHANGED');
        const prepared = await prepareTeiRuntime(context, input);
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
                await db.collection.update({
                    where: { id: collection.id },
                    data: { contentSequence: { increment: 0 } },
                });
                const current = await currentRerankProfile(
                    db,
                    actor.organizationId,
                    collection.id
                );
                if (
                    !extended &&
                    current &&
                    !isHostedRerankingProvider(current.provider)
                )
                    throw rerankError('PROFILE_UNSUPPORTED');
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
                const binding = input.enabled
                    ? await currentRerankBinding(
                          db,
                          actor.organizationId,
                          provider
                      )
                    : {
                          credentialId: null,
                          selfHostedCredentialId: null,
                          credentialRevision: null,
                          endpoint: null,
                      };
                if (
                    prepared &&
                    (binding.credentialId !== prepared.binding.credentialId ||
                        binding.selfHostedCredentialId !==
                            prepared.binding.selfHostedCredentialId ||
                        binding.credentialRevision !==
                            prepared.binding.credentialRevision ||
                        binding.endpoint !== prepared.binding.endpoint)
                )
                    throw rerankError('RERANK_PROFILE_CHANGED');
                const revision = (current?.revision ?? 0) + 1;
                await db.collectionRerankConfig.create({
                    data: {
                        organizationId: actor.organizationId,
                        collectionId: collection.id,
                        revision,
                        enabled: input.enabled,
                        provider,
                        model: input.model,
                        candidatePool: input.candidatePool,
                        capabilityVersion:
                            provider === 'TEI'
                                ? TEI_CAPABILITY_VERSION
                                : RERANK_CAPABILITY_VERSION,
                        ...binding,
                        runtimeSnapshot: prepared
                            ? { ...prepared.snapshot }
                            : Prisma.DbNull,
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
                        provider,
                        model: input.model,
                        candidatePool: input.candidatePool,
                    }
                );
                return getExtendedRerankProfile(context, collection.id, db);
            }
        );
    } catch (error) {
        throw safeRerankError(error);
    }
}

/** Legacy configuration remains hosted-only and cannot overwrite a selected self-hosted profile. */
export async function configureRerankProfile(
    context: AuthorizedContext,
    input: ConfigureRerankInput
) {
    return rerankProfileView.parse(
        await configureProfile(context, input, false)
    );
}

/** Open engine identifiers are validated against the native registry before metadata or mutation. */
export function configureExtendedRerankProfile(
    context: AuthorizedContext,
    input: ConfigureRerankInput
) {
    return configureProfile(context, input, true);
}
