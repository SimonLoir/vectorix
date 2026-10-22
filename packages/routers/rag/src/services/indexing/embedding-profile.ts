import type { Prisma } from '@repo/db';
import {
    canonicalEmbeddingModel,
    type EmbeddingConfiguration,
    type ModelIdentity,
} from '@repo/embeddings';
import {
    resolveCollectionCredential,
    resolveCredential,
} from '../credential-resolution';
import { indexError } from './errors';

function normalizeEndpoint(value: string) {
    const url = new URL(value);
    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    )
        throw new Error('Invalid embedding destination.');
    return url.href.replace(/\/$/, '');
}
/** Network destinations require an exact operator-approved URL; organization credentials alone never authorize SSRF. */
export function assertEmbeddingEndpoint(
    endpoint: string,
    provider: 'OLLAMA' | 'COHERE' | 'VOYAGE' | 'OPENAI' | 'MISTRAL' = 'OLLAMA'
) {
    const allowed = [
        process.env[`VECTORIX_DEFAULT_${provider}_ENDPOINT`],
        ...(process.env.VECTORIX_EMBEDDING_ALLOWED_ENDPOINTS ?? '').split(','),
    ].filter((value): value is string => Boolean(value?.trim()));
    try {
        const normalized = normalizeEndpoint(endpoint);
        if (
            allowed.some(
                (candidate) =>
                    normalizeEndpoint(candidate.trim()) === normalized
            )
        )
            return;
    } catch {
        // Invalid operator configuration fails closed without echoing credentials or private destinations.
    }
    throw indexError('CREDENTIALS_INVALID');
}
/** Saved collection bindings take precedence over current organization selections; invalid bindings never fall back. */
export async function boundEmbeddingConfiguration(
    db: Prisma.TransactionClient,
    organizationId: string,
    collectionId: string,
    revision: number
): Promise<EmbeddingConfiguration> {
    const resolved = await resolveCollectionCredential(
        db,
        organizationId,
        collectionId,
        revision
    ).catch(() => {
        throw indexError('CREDENTIALS_INVALID');
    });
    if (
        resolved.data.provider !== 'OLLAMA' &&
        resolved.data.provider !== 'COHERE' &&
        resolved.data.provider !== 'VOYAGE' &&
        resolved.data.provider !== 'OPENAI' &&
        resolved.data.provider !== 'MISTRAL'
    )
        throw indexError('PROFILE_UNSUPPORTED');
    assertEmbeddingEndpoint(resolved.data.endpoint, resolved.data.provider);
    return resolved.data;
}
/** Discovery resolves one complete active configuration using the same organization-first policy as revisions. */
export async function currentEmbeddingConfiguration(
    db: Prisma.TransactionClient,
    organizationId: string
): Promise<EmbeddingConfiguration> {
    const resolved = await resolveCredential(
        db,
        organizationId,
        'OLLAMA'
    ).catch(() => {
        throw indexError('CREDENTIALS_INVALID');
    });
    if (resolved.data.provider !== 'OLLAMA')
        throw indexError('PROFILE_UNSUPPORTED');
    assertEmbeddingEndpoint(resolved.data.endpoint);
    return resolved.data;
}
export type IndexProfile = {
    provider: string;
    chunkingStrategy: string;
    parentChild: boolean;
    embeddingPreset?: string;
};

/** Catalog drafts remain editable; execution opens only complete provider/chunker journeys. */
export function supportsIndexProfile(profile: IndexProfile) {
    const preset = profile.embeddingPreset ?? 'GENERIC';
    return (
        ['DOCUMENT_STRUCTURE', 'TOKEN_WINDOW'].includes(
            profile.chunkingStrategy
        ) &&
        !profile.parentChild &&
        ((profile.provider === 'OLLAMA' &&
            ['GENERIC', 'EMBEDDING_GEMMA'].includes(preset)) ||
            (['COHERE', 'VOYAGE', 'OPENAI', 'MISTRAL'].includes(
                profile.provider
            ) &&
                preset === 'GENERIC'))
    );
}

/** Fail before provider I/O for a profile whose full indexing/search path is unavailable. */
export function assertSupportedIndexProfile(profile: IndexProfile) {
    if (!supportsIndexProfile(profile)) throw indexError('PROFILE_UNSUPPORTED');
}

/** A saved manifest must match provider as well as model; hosted fingerprints do not assert weight immutability. */
export function matchesEmbeddingIdentity(
    identity: ModelIdentity,
    profile: {
        provider: string;
        model: string;
        dimensions: number;
        embeddingPreset: string;
    },
    fingerprint: string
) {
    return (
        identity.provider === profile.provider &&
        identity.digest === fingerprint &&
        identity.model ===
            canonicalEmbeddingModel(identity.provider, profile.model) &&
        identity.dimensions === profile.dimensions &&
        identity.preset === profile.embeddingPreset
    );
}
