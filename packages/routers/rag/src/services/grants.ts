import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { mutate, audit } from './mutation';
import { requireCollection } from './access';

type Target = { type: 'member' | 'group'; id: string };
type Permissions = {
    read: boolean;
    manageDocuments: boolean;
    administer: boolean;
};
/** Both principal and collection identifiers are resolved inside the authenticated organization. */
export function changeGrant(
    context: AuthorizedContext,
    input: { id: string; target: Target; permissions?: Permissions }
) {
    return mutate(
        context,
        { ragCollection: ['manageGrants'] },
        async (db, actor) => {
            await requireCollection(db, actor, input.id, 'administer');
            const scope = {
                organizationId: actor.organizationId,
                collectionId: input.id,
            };
            if (input.target.type === 'member') {
                if (
                    !(await db.member.findFirst({
                        where: {
                            organizationId: actor.organizationId,
                            id: input.target.id,
                        },
                    }))
                )
                    throw new ORPCError('NOT_FOUND');
                await (input.permissions
                    ? db.collectionMemberGrant.upsert({
                          where: {
                              ['collectionId_memberId']: {
                                  collectionId: input.id,
                                  memberId: input.target.id,
                              },
                          },
                          create: {
                              ...scope,
                              memberId: input.target.id,
                              ...input.permissions,
                          },
                          update: input.permissions,
                      })
                    : db.collectionMemberGrant.deleteMany({
                          where: { ...scope, memberId: input.target.id },
                      }));
            } else {
                if (
                    !(await db.organizationGroup.findFirst({
                        where: {
                            organizationId: actor.organizationId,
                            id: input.target.id,
                        },
                    }))
                )
                    throw new ORPCError('NOT_FOUND');
                await (input.permissions
                    ? db.collectionGroupGrant.upsert({
                          where: {
                              ['collectionId_groupId']: {
                                  collectionId: input.id,
                                  groupId: input.target.id,
                              },
                          },
                          create: {
                              ...scope,
                              groupId: input.target.id,
                              ...input.permissions,
                          },
                          update: input.permissions,
                      })
                    : db.collectionGroupGrant.deleteMany({
                          where: { ...scope, groupId: input.target.id },
                      }));
            }
            await audit(
                db,
                actor,
                input.permissions
                    ? 'collection.grant.set'
                    : 'collection.grant.remove',
                input.id,
                {
                    principalType: input.target.type,
                    principalId: input.target.id,
                    ...input.permissions,
                }
            );
            return { success: true as const };
        }
    );
}
