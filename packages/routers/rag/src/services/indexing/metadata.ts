import { ORPCError } from '@orpc/server';
import type { RagContentLanguage } from '@repo/db';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { requireCollection } from '../access';
import { mutate, audit } from '../mutation';
import { recordDocumentChange } from './changes';
import { validateMetadata } from './metadata-validation';

/** Update a collection's own document filter snapshot; shared library metadata is never mutated. */
export function updateDocumentMetadata(
    context: AuthorizedContext,
    input: {
        collectionId: string;
        documentId: string;
        expectedMetadataRevision: number;
        language: RagContentLanguage;
        tags: string[];
        metadata: Record<string, string | number | boolean>;
    }
) {
    return mutate(
        context,
        { ragCollection: ['manageDocuments'] },
        async (tx, actor) => {
            const collection = await requireCollection(
                tx,
                actor,
                input.collectionId,
                'manageDocuments'
            );
            const profile = await tx.collectionConfigRevision.findUniqueOrThrow(
                {
                    where: {
                        ['organizationId_collectionId_revision']: {
                            organizationId: actor.organizationId,
                            collectionId: collection.id,
                            revision: collection.configurationRevision,
                        },
                    },
                }
            );
            const metadata = validateMetadata(
                profile.metadataFields,
                input.metadata
            );
            const changed = await tx.collectionDocument.updateMany({
                where: {
                    organizationId: actor.organizationId,
                    collectionId: collection.id,
                    documentId: input.documentId,
                    metadataRevision: input.expectedMetadataRevision,
                    document: { deletedAt: null },
                },
                data: {
                    metadataRevision: { increment: 1 },
                    language: input.language,
                    tags: [...new Set(input.tags)],
                    metadata,
                },
            });
            if (!changed.count)
                throw new ORPCError('CONFLICT', {
                    message:
                        'The document association changed. Reload before updating metadata.',
                });
            await recordDocumentChange(tx, {
                organizationId: actor.organizationId,
                collectionId: collection.id,
                documentId: input.documentId,
                kind: 'UPSERT',
                requestedBy: actor.userId,
            });
            await audit(
                tx,
                actor,
                'document.collection.metadata',
                input.documentId,
                {
                    collectionId: collection.id,
                    revision: input.expectedMetadataRevision + 1,
                }
            );
            return { success: true as const };
        }
    );
}
