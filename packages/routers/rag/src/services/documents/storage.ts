import { createHash } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { Prisma } from '@repo/db';
import { assertStorageEndpoint, type S3Configuration } from '@repo/storage';
import { credentialInclude, decryptCredential } from '../credential-data';
import {
    resolveCredential,
    platformCredential,
} from '../credential-resolution';

export function contentHash(bytes: Uint8Array | string) {
    return createHash('sha256').update(bytes).digest('hex');
}
const destination = (
    data: Pick<
        S3Configuration,
        'endpoint' | 'region' | 'bucket' | 'forcePathStyle'
    >
) => ({
    endpoint: data.endpoint,
    region: data.region,
    bucket: data.bucket,
    forcePathStyle: data.forcePathStyle,
});
/** Persist the full non-secret destination, so subsequent active selections cannot retarget existing originals. */
export async function uploadStorage(
    db: Prisma.TransactionClient,
    organizationId: string
) {
    const resolved = await resolveCredential(db, organizationId, 'S3');
    if (resolved.data.provider !== 'S3') throw new ORPCError('CONFLICT');
    assertStorageEndpoint(resolved.data.endpoint);
    const fingerprint = contentHash(
        JSON.stringify({
            ...destination(resolved.data),
            credentialId: resolved.credentialId,
        })
    );
    const location = await db.storageLocation.upsert({
        where: {
            ['organizationId_fingerprint']: { organizationId, fingerprint },
        },
        create: {
            organizationId,
            credentialId: resolved.credentialId,
            fingerprint,
            ...destination(resolved.data),
        },
        update: {},
    });
    return { location, config: resolved.data };
}
/** Resolve a retained location using its own credential binding, never the current active organization selection. */
export async function boundStorage(
    db: Prisma.TransactionClient,
    organizationId: string,
    storageLocationId: string
): Promise<S3Configuration> {
    const location = await db.storageLocation.findFirst({
        where: { id: storageLocationId, organizationId },
    });
    if (!location) throw new ORPCError('NOT_FOUND');
    let data;
    if (location.credentialId) {
        const credential = await db.credentials.findFirst({
            where: {
                id: location.credentialId,
                organizationId,
                provider: 'S3',
            },
            include: credentialInclude,
        });
        if (!credential) throw new ORPCError('CONFLICT');
        data = decryptCredential(credential);
    } else {
        // A platform binding must remain platform-bound even if an organization later selects S3 credentials.
        data = platformCredential('S3').data;
    }
    if (
        data.provider !== 'S3' ||
        JSON.stringify(destination(data)) !==
            JSON.stringify(destination(location))
    )
        throw new ORPCError('CONFLICT', {
            message: 'The retained storage destination is unavailable.',
        });
    assertStorageEndpoint(data.endpoint);
    return data;
}
