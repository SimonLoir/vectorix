import { randomUUID } from 'node:crypto';
import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import {
    changesSecretDestination,
    suppliesSecretsForDestination,
    updateProviderData,
} from './credential-update';
import {
    credentialData,
    credentialUpdateData,
} from '@repo/api-contracts/v1/rag/credentials';
import { mutate, audit } from './mutation';
import {
    credentialInclude,
    credentialDto,
    encryptedProviderData,
} from './credential-data';

export function createCredential(
    context: AuthorizedContext,
    input: {
        name: string;
        data: typeof credentialData._output;
        activate: boolean;
    }
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            if (
                (await db.credentials.count({
                    where: { organizationId: actor.organizationId },
                })) >= 50
            )
                throw new ORPCError('CONFLICT', {
                    message: 'The organization credential limit is reached.',
                });
            // Generate the ID first so ciphertexts can be bound to this row.
            const credentialId = randomUUID();
            const credential = await db.credentials.create({
                data: {
                    id: credentialId,
                    ...(await encryptedProviderData(
                        input.data,
                        actor.organizationId,
                        credentialId
                    )),
                    name: input.name,
                    provider: input.data.provider,
                    organization: { connect: { id: actor.organizationId } },
                },
            });
            if (input.activate)
                await db.credentialSelection.upsert({
                    where: {
                        ['organizationId_provider']: {
                            organizationId: actor.organizationId,
                            provider: credential.provider,
                        },
                    },
                    create: {
                        organizationId: actor.organizationId,
                        provider: credential.provider,
                        credentialId: credential.id,
                    },
                    update: { credentialId: credential.id },
                });
            await audit(db, actor, 'credential.create', credential.id, {
                provider: credential.provider,
                active: input.activate,
            });
            return credentialDto(
                await db.credentials.findUniqueOrThrow({
                    where: { id: credential.id },
                    include: credentialInclude,
                })
            );
        }
    );
}

export function updateCredential(
    context: AuthorizedContext,
    input: {
        id: string;
        name: string;
        expectedRevision: number;
        data: typeof credentialUpdateData._output;
    }
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            const current = await db.credentials.findFirst({
                where: { id: input.id, organizationId: actor.organizationId },
                include: credentialInclude,
            });
            if (!current) throw new ORPCError('NOT_FOUND');
            if (
                current.revision !== input.expectedRevision ||
                current.provider !== input.data.provider
            )
                throw new ORPCError('CONFLICT', {
                    message: 'Credential revision or provider changed.',
                });
            const old = credentialDto(current).data;
            const changedDestination =
                old.endpoint !== input.data.endpoint ||
                (old.provider === 'S3' &&
                    input.data.provider === 'S3' &&
                    (old.bucket !== input.data.bucket ||
                        old.region !== input.data.region ||
                        old.forcePathStyle !== input.data.forcePathStyle));
            if (
                changedDestination &&
                ((await db.storageLocation.count({
                    where: {
                        organizationId: actor.organizationId,
                        credentialId: current.id,
                    },
                })) ||
                    (await db.collectionConfigRevision.count({
                        where: {
                            organizationId: actor.organizationId,
                            credentialId: current.id,
                        },
                    })))
            )
                throw new ORPCError('CONFLICT', {
                    message:
                        'This destination is referenced. Create and activate new credentials for new writes or a new collection revision.',
                });
            const movedSecret = changesSecretDestination(old, input.data);
            if (movedSecret && !suppliesSecretsForDestination(old, input.data))
                throw new ORPCError('BAD_REQUEST', {
                    message:
                        'Re-enter the secret when changing the endpoint, bucket, or S3 addressing mode.',
                });
            await updateProviderData(db, current, input.data);
            const result = await db.credentials.update({
                where: { id: current.id },
                data: { name: input.name, revision: { increment: 1 } },
                include: credentialInclude,
            });
            await audit(db, actor, 'credential.update', current.id, {
                revision: result.revision,
                // Audit readers may lack credential access, so record the fact, not the URLs.
                ...(movedSecret ? { destinationChanged: true } : {}),
            });
            return credentialDto(result);
        }
    );
}

export function activateCredential(context: AuthorizedContext, id: string) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            const credential = await db.credentials.findFirst({
                where: { id, organizationId: actor.organizationId },
            });
            if (!credential) throw new ORPCError('NOT_FOUND');
            await db.credentialSelection.upsert({
                where: {
                    ['organizationId_provider']: {
                        organizationId: actor.organizationId,
                        provider: credential.provider,
                    },
                },
                create: {
                    organizationId: actor.organizationId,
                    provider: credential.provider,
                    credentialId: id,
                },
                update: { credentialId: id },
            });
            await audit(db, actor, 'credential.activate', id, {
                provider: credential.provider,
            });
            return { success: true as const };
        }
    );
}

export function deleteCredential(
    context: AuthorizedContext,
    input: { id: string; expectedRevision: number }
) {
    return mutate(
        context,
        { ragCredentials: ['manage'] },
        async (db, actor) => {
            const credential = await db.credentials.findFirst({
                where: { id: input.id, organizationId: actor.organizationId },
            });
            if (!credential) throw new ORPCError('NOT_FOUND');
            if (credential.revision !== input.expectedRevision)
                throw new ORPCError('CONFLICT');
            if (
                (await db.storageLocation.count({
                    where: {
                        organizationId: actor.organizationId,
                        credentialId: credential.id,
                    },
                })) ||
                (await db.collectionConfigRevision.count({
                    where: {
                        organizationId: actor.organizationId,
                        credentialId: credential.id,
                    },
                }))
            )
                throw new ORPCError('CONFLICT', {
                    message:
                        'Credentials are still referenced by stored documents or collection revisions.',
                });
            await db.credentials.delete({ where: { id: credential.id } });
            await audit(db, actor, 'credential.delete', credential.id);
            return { success: true as const };
        }
    );
}
