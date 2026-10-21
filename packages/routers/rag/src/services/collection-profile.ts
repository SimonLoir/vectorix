import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { collectionProfile } from '@repo/api-contracts/v1/rag/collections';
import { resolveCredential } from './credential-resolution';

/** A platform connection is an organization-scoped catalog reference, never a client-provided URL. */
export function platformConnection(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const schema = process.env.VECTOR_DATABASE_SCHEMA ?? 'vector_collections';
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
        throw new ORPCError('CONFLICT', {
            message: 'Invalid platform vector schema.',
        });
    return db.vectorConnection.upsert({
        where: { ['organizationId_key']: { organizationId, key: 'platform' } },
        create: { organizationId, key: 'platform', schema },
        update: {},
    });
}

/** Snapshot immutable non-secret embedding settings. Key rotation does not rewrite collection revisions. */
export async function profileData(
    db: Prisma.TransactionClient,
    organizationId: string,
    profile: typeof collectionProfile._output
) {
    const resolved = await resolveCredential(
        db,
        organizationId,
        profile.provider
    );
    const connection = await platformConnection(db, organizationId);
    return {
        ...profile,
        credentialId: resolved.credentialId,
        credentialRevision: resolved.revision,
        endpoint: resolved.data.endpoint,
        vectorConnectionId: connection.id,
    };
}
