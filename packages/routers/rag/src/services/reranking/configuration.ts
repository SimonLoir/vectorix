import type { CollectionRerankConfig, Prisma } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    listRerankingModels,
    type RerankingProvider,
} from '@repo/reranking/models';
import type { RerankingConfiguration } from '@repo/reranking';
import { credentialInclude, decryptCredential } from '../credential-data';
import {
    platformCredential,
    resolveCredential,
} from '../credential-resolution';
import { assertRerankingEndpoint } from './endpoint-policy';
import { rerankError } from './errors';
import type { RerankRun } from './accounting';

export const RERANK_CAPABILITY_VERSION = 'native-rerank-v1';

export function isRerankingProvider(
    provider: string
): provider is RerankingProvider {
    return provider === 'COHERE' || provider === 'VOYAGE';
}

/** Only the reviewed native protocol/version pair may execute; hosted names do not attest to model weights. */
export function supportsRerankConfiguration(
    configuration: Pick<
        CollectionRerankConfig,
        'provider' | 'model' | 'capabilityVersion'
    >
) {
    return (
        isRerankingProvider(configuration.provider) &&
        configuration.capabilityVersion === RERANK_CAPABILITY_VERSION &&
        listRerankingModels(configuration.provider).some(
            (model) => model.id === configuration.model
        )
    );
}

/** Enabling snapshots one complete organization-first binding without any provider I/O. */
export async function currentRerankBinding(
    db: Prisma.TransactionClient,
    organizationId: string,
    provider: RerankingProvider
) {
    try {
        const resolved = await resolveCredential(db, organizationId, provider);
        if (
            resolved.data.provider !== provider ||
            !isRerankingProvider(resolved.data.provider)
        )
            throw rerankError('CREDENTIALS_INVALID');
        assertRerankingEndpoint(provider, resolved.data.endpoint);
        return {
            credentialId: resolved.credentialId,
            credentialRevision: resolved.revision,
            endpoint: resolved.data.endpoint,
        };
    } catch {
        throw rerankError('CREDENTIALS_INVALID');
    }
}

/**
 * Reopen the immutable destination binding for an admitted run. Credential secret
 * rotation is allowed, but deleted, foreign, wrong-provider or retargeted rows
 * never fall back to the platform or the organization's newly selected row.
 */
export async function boundRerankingConfiguration(
    db: Prisma.TransactionClient,
    organizationId: string,
    configuration: CollectionRerankConfig
): Promise<RerankingConfiguration> {
    if (configuration.organizationId !== organizationId)
        throw rerankError('ACCESS_REVOKED');
    if (!configuration.enabled) throw rerankError('RERANK_DISABLED');
    if (
        !supportsRerankConfiguration(configuration) ||
        !isRerankingProvider(configuration.provider)
    )
        throw rerankError('PROFILE_UNSUPPORTED');
    const provider = configuration.provider;
    const endpoint = configuration.endpoint;
    if (!endpoint) throw rerankError('CREDENTIALS_INVALID');
    try {
        let data;
        if (configuration.credentialId) {
            const credential = await db.credentials.findFirst({
                where: {
                    id: configuration.credentialId,
                    organizationId,
                    provider,
                },
                include: credentialInclude,
            });
            if (
                !credential ||
                !configuration.credentialRevision ||
                credential.revision < configuration.credentialRevision
            )
                throw rerankError('CREDENTIALS_INVALID');
            data = decryptCredential(credential);
        } else {
            if (configuration.credentialRevision !== null)
                throw rerankError('CREDENTIALS_INVALID');
            data = platformCredential(provider).data;
        }
        if (
            (data.provider !== 'COHERE' && data.provider !== 'VOYAGE') ||
            data.provider !== provider ||
            data.endpoint !== endpoint
        )
            throw rerankError('CREDENTIALS_INVALID');
        assertRerankingEndpoint(provider, endpoint);
        return { provider, endpoint, apiKey: data.apiKey };
    } catch {
        throw rerankError('CREDENTIALS_INVALID');
    }
}

/** Resolve only the run's captured saved configuration, never the currently selected credential. */
export async function resolveRerankConfiguration(
    context: AuthorizedContext,
    run: RerankRun
): Promise<RerankingConfiguration> {
    if (run.organizationId !== context.organizationId)
        throw rerankError('ACCESS_REVOKED');
    const configuration = await context.db.collectionRerankConfig.findFirst({
        where: {
            id: run.profile.id,
            organizationId: context.organizationId,
            collectionId: run.collectionId,
        },
    });
    if (
        !configuration ||
        configuration.revision !== run.profile.revision ||
        configuration.provider !== run.profile.provider ||
        configuration.model !== run.profile.model ||
        configuration.candidatePool !== run.profile.candidatePool ||
        configuration.capabilityVersion !== run.profile.capabilityVersion ||
        configuration.endpoint !== run.profile.endpoint ||
        configuration.credentialId !== run.profile.credentialId
    )
        throw rerankError('RERANK_PROFILE_CHANGED');
    return boundRerankingConfiguration(
        context.db,
        context.organizationId,
        configuration
    );
}
