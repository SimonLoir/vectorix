import type { Prisma } from '@repo/db';
import type { OllamaConfiguration } from '@repo/embeddings';
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
export function assertEmbeddingEndpoint(endpoint: string) {
    const allowed = [
        process.env.VECTORIX_DEFAULT_OLLAMA_ENDPOINT,
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
): Promise<OllamaConfiguration> {
    const resolved = await resolveCollectionCredential(
        db,
        organizationId,
        collectionId,
        revision
    ).catch(() => {
        throw indexError('CREDENTIALS_INVALID');
    });
    if (resolved.data.provider !== 'OLLAMA')
        throw indexError('PROFILE_UNSUPPORTED');
    assertEmbeddingEndpoint(resolved.data.endpoint);
    return resolved.data;
}
/** Discovery resolves one complete active configuration using the same organization-first policy as revisions. */
export async function currentEmbeddingConfiguration(
    db: Prisma.TransactionClient,
    organizationId: string
): Promise<OllamaConfiguration> {
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
/** Unsupported planned profiles remain editable catalog drafts, but cannot start a partially supported indexing journey. */
export function assertM3Profile(profile: {
    provider: string;
    chunkingStrategy: string;
    parentChild: boolean;
    embeddingPreset?: string;
}) {
    if (
        profile.provider !== 'OLLAMA' ||
        profile.chunkingStrategy !== 'DOCUMENT_STRUCTURE' ||
        profile.parentChild ||
        !['GENERIC', 'EMBEDDING_GEMMA'].includes(
            profile.embeddingPreset ?? 'GENERIC'
        )
    )
        throw indexError('PROFILE_UNSUPPORTED');
}
