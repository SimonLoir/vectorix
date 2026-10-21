import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { credentialData } from '@repo/api-contracts/v1/rag/credentials';
import { credentialInclude, decryptCredential } from './credential-data';

type Provider = typeof credentialData._output.provider;
/** Resolve a complete provider configuration. Never mix organization keys with platform endpoints. */
export async function resolveCredential(
    db: Prisma.TransactionClient,
    organizationId: string,
    provider: Provider
) {
    const selected = await db.credentialSelection.findUnique({
        where: { ['organizationId_provider']: { organizationId, provider } },
        include: { credential: { include: credentialInclude } },
    });
    if (selected)
        return {
            source: 'organization' as const,
            credentialId: selected.credentialId,
            revision: selected.credential.revision,
            data: decryptCredential(selected.credential),
        };
    if (await db.credentials.count({ where: { organizationId, provider } }))
        throw new ORPCError('CONFLICT', {
            message:
                'Select an active organization credential for this provider.',
        });
    return platformCredential(provider);
}

/** Read one complete environment configuration, without organization overrides. */
function platformCredential(provider: Provider) {
    const prefix = `VECTORIX_DEFAULT_${provider}_`;
    const env = (name: string) => process.env[`${prefix}${name}`];
    const configuration =
        provider === 'S3'
            ? {
                  provider,
                  endpoint: env('ENDPOINT'),
                  region: env('REGION'),
                  bucket: env('BUCKET'),
                  forcePathStyle: env('FORCE_PATH_STYLE') === 'true',
                  accessKeyId: env('ACCESS_KEY_ID'),
                  secretAccessKey: env('SECRET_ACCESS_KEY'),
              }
            : {
                  provider,
                  endpoint: env('ENDPOINT'),
                  apiKey:
                      provider === 'OLLAMA'
                          ? env('API_KEY') === ''
                              ? null
                              : (env('API_KEY') ?? null)
                          : env('API_KEY'),
              };
    const parsed = credentialData.safeParse(configuration);
    if (!parsed.success)
        throw new ORPCError('CONFLICT', {
            message:
                'No valid platform credentials are configured for this provider.',
        });
    return {
        source: 'platform' as const,
        credentialId: null,
        revision: null,
        data: parsed.data,
    };
}

/** Resolve a saved revision's provider binding. Secret rotation is allowed; destination changes require a new revision. */
export async function resolveCollectionCredential(
    db: Prisma.TransactionClient,
    organizationId: string,
    collectionId: string,
    revision: number
) {
    const configuration = await db.collectionConfigRevision.findUnique({
        where: {
            ['organizationId_collectionId_revision']: {
                organizationId,
                collectionId,
                revision,
            },
        },
    });
    if (!configuration) throw new ORPCError('NOT_FOUND');
    let resolved;
    if (configuration.credentialId) {
        const credential = await db.credentials.findFirst({
            where: {
                organizationId,
                id: configuration.credentialId,
                provider: configuration.provider,
            },
            include: credentialInclude,
        });
        if (!credential)
            throw new ORPCError('CONFLICT', {
                message: 'The collection credential is unavailable.',
            });
        resolved = {
            source: 'organization' as const,
            credentialId: credential.id,
            revision: credential.revision,
            data: decryptCredential(credential),
        };
    } else {
        resolved = platformCredential(configuration.provider);
    }
    if (resolved.data.endpoint !== configuration.endpoint)
        throw new ORPCError('CONFLICT', {
            message:
                'The provider destination changed. Create a new collection configuration revision.',
        });
    return resolved;
}
