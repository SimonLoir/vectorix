import type { Prisma } from '@repo/db';
import {
    ChunkingError,
    resolveChunkingStrategy,
    SEMANTIC_CHUNKER_VERSION,
    SEMANTIC_UNITIZER_VERSION,
} from '@repo/chunking';
import {
    assertSupportedIndexProfile,
    type IndexProfile,
} from './embedding-profile';
import { indexError } from './errors';

/** Resolve the exact saved strategy/version pair before any credential, source or provider I/O. */
export function resolveIndexChunking(
    profile: IndexProfile,
    savedVersion?: string
) {
    assertSupportedIndexProfile(profile);
    try {
        if (profile.chunkingStrategy === 'SEMANTIC') {
            if (
                savedVersion !== undefined &&
                savedVersion !== SEMANTIC_CHUNKER_VERSION
            )
                throw new ChunkingError('INVALID_CHUNK_PROFILE');
            return {
                kind: 'SEMANTIC' as const,
                version: SEMANTIC_CHUNKER_VERSION,
                unitizerVersion: SEMANTIC_UNITIZER_VERSION,
            };
        }
        return {
            ...resolveChunkingStrategy(profile.chunkingStrategy, savedVersion),
            kind: 'SYNCHRONOUS' as const,
        };
    } catch (error) {
        if (error instanceof ChunkingError)
            throw indexError(
                savedVersion === undefined
                    ? 'PROFILE_UNSUPPORTED'
                    : 'MODEL_CHANGED'
            );
        throw error;
    }
}

/** Database-only worker preflight; cleanup deliberately does not require an executable historical profile. */
export async function requireGenerationChunking(
    db: Prisma.TransactionClient,
    organizationId: string,
    generationId: string
) {
    const generation = await db.indexGeneration.findFirst({
        where: { organizationId, id: generationId },
        select: { configuration: true, chunkerVersion: true },
    });
    if (!generation) throw indexError('MODEL_CHANGED');
    return resolveIndexChunking(
        generation.configuration,
        generation.chunkerVersion
    );
}

/** A retry must reject a future persisted unitizer before reading its source or opening a vector destination. */
export async function requireSemanticPlanVersion(
    db: Prisma.TransactionClient,
    organizationId: string,
    generationId: string,
    candidateId: string
) {
    const plan = await db.semanticChunkPlan.findFirst({
        where: { organizationId, generationId, indexedDocumentId: candidateId },
        select: { chunkerVersion: true, unitizerVersion: true, state: true },
    });
    if (
        plan &&
        (plan.chunkerVersion !== SEMANTIC_CHUNKER_VERSION ||
            plan.unitizerVersion !== SEMANTIC_UNITIZER_VERSION ||
            plan.state === 'CLEANED')
    )
        throw indexError('MODEL_CHANGED');
}
