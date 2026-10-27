import type { CollectionRerankConfig, Prisma } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    supportsRerankingModel,
    type RerankingProvider,
} from '@repo/reranking/models';
import {
    parseTeiRuntimeSnapshot,
    type RerankingConfiguration,
} from '@repo/reranking';
import { credentialInclude, decryptCredential } from '../credential-data';
import {
    platformCredential,
    resolveCredential,
} from '../credential-resolution';
import { assertRerankingEndpoint } from './endpoint-policy';
import {
    decryptRerankEndpoint,
    platformRerankEndpoint,
    resolveRerankEndpoint,
} from './endpoint-data';
import { rerankError } from './errors';
import type { RerankRun } from './accounting';

export const RERANK_CAPABILITY_VERSION = 'native-rerank-v1';
export const TEI_CAPABILITY_VERSION = 'native-tei-v1';

export function isHostedRerankingProvider(
    provider: string
): provider is 'COHERE' | 'VOYAGE' {
    return provider === 'COHERE' || provider === 'VOYAGE';
}
export function isRerankingProvider(
    provider: string
): provider is RerankingProvider {
    return isHostedRerankingProvider(provider) || provider === 'TEI';
}

/** Saved protocol and model support are checked before any cost claim or external operation. */
export function supportsRerankConfiguration(
    configuration: Pick<
        CollectionRerankConfig,
        | 'provider'
        | 'model'
        | 'capabilityVersion'
        | 'runtimeSnapshot'
        | 'candidatePool'
        | 'selfHostedCredentialId'
    >
) {
    if (
        !isRerankingProvider(configuration.provider) ||
        !supportsRerankingModel(configuration.provider, configuration.model)
    )
        return false;
    if (configuration.provider !== 'TEI')
        return (
            configuration.capabilityVersion === RERANK_CAPABILITY_VERSION &&
            configuration.runtimeSnapshot === null &&
            configuration.selfHostedCredentialId === null
        );
    try {
        const snapshot = parseTeiRuntimeSnapshot(configuration.runtimeSnapshot);
        return (
            configuration.capabilityVersion === TEI_CAPABILITY_VERSION &&
            snapshot.modelId === configuration.model &&
            configuration.candidatePool <= snapshot.maxClientBatchSize
        );
    } catch {
        return false;
    }
}

/** Enabling snapshots one complete organization-first destination; no inference is performed here. */
export async function currentRerankBinding(
    db: Prisma.TransactionClient,
    organizationId: string,
    provider: RerankingProvider
) {
    try {
        if (provider === 'TEI') {
            const resolved = await resolveRerankEndpoint(db, organizationId);
            return {
                credentialId: null,
                selfHostedCredentialId: resolved.selfHostedCredentialId,
                credentialRevision: resolved.credentialRevision,
                endpoint: resolved.data.endpoint,
            };
        }
        const resolved = await resolveCredential(db, organizationId, provider);
        if (
            resolved.data.provider !== provider ||
            !isHostedRerankingProvider(resolved.data.provider)
        )
            throw rerankError('CREDENTIALS_INVALID');
        assertRerankingEndpoint(provider, resolved.data.endpoint);
        return {
            credentialId: resolved.credentialId,
            selfHostedCredentialId: null,
            credentialRevision: resolved.revision,
            endpoint: resolved.data.endpoint,
        };
    } catch {
        throw rerankError('CREDENTIALS_INVALID');
    }
}

/** Exact saved bindings survive selection changes, allow secret rotation and refuse any destination retargeting. */
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
        if (provider === 'TEI') {
            if (configuration.credentialId !== null)
                throw rerankError('CREDENTIALS_INVALID');
            let data;
            if (configuration.selfHostedCredentialId) {
                const credential = await db.rerankEndpointCredential.findFirst({
                    where: {
                        id: configuration.selfHostedCredentialId,
                        organizationId,
                        provider: 'TEI',
                    },
                });
                if (
                    !credential ||
                    !configuration.credentialRevision ||
                    credential.revision < configuration.credentialRevision
                )
                    throw rerankError('CREDENTIALS_INVALID');
                data = decryptRerankEndpoint(credential);
            } else {
                if (configuration.credentialRevision !== null)
                    throw rerankError('CREDENTIALS_INVALID');
                data = platformRerankEndpoint();
            }
            if (data.endpoint !== endpoint)
                throw rerankError('CREDENTIALS_INVALID');
            assertRerankingEndpoint(provider, endpoint);
            return {
                ...data,
                runtimeSnapshot: parseTeiRuntimeSnapshot(
                    configuration.runtimeSnapshot
                ),
            };
        }
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
            !isHostedRerankingProvider(data.provider) ||
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

/** Resolve only the captured immutable revision; neither the latest profile nor a newly selected credential grants authority. */
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
        configuration.credentialId !== run.profile.credentialId ||
        configuration.selfHostedCredentialId !==
            run.profile.selfHostedCredentialId ||
        JSON.stringify(configuration.runtimeSnapshot) !==
            JSON.stringify(run.profile.runtimeSnapshot)
    )
        throw rerankError('RERANK_PROFILE_CHANGED');
    return boundRerankingConfiguration(
        context.db,
        context.organizationId,
        configuration
    );
}
