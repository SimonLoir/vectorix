import type { Prisma } from '@repo/db';
import { ChunkingError, resolveChunkingStrategy } from '@repo/chunking';
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
        return resolveChunkingStrategy(profile.chunkingStrategy, savedVersion);
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
