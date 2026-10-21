import { ragV1 } from '../v1-implementer';
import { ragActor, requireCollection } from '../services/access';
export const listCollectionGrants = ragV1.collections.grants.handler(
    async ({ context, input }) => {
        const actor = await ragActor(
            context,
            context.db,
            { ragCollection: ['manageGrants'] },
            true
        );
        await requireCollection(context.db, actor, input.id, 'administer');
        const memberWhere = {
            organizationId: actor.organizationId,
            collectionId: input.id,
            member: {
                user: {
                    name: {
                        contains: input.query,
                        mode: 'insensitive' as const,
                    },
                },
            },
        };
        const groupWhere = {
            organizationId: actor.organizationId,
            collectionId: input.id,
            group: {
                name: { contains: input.query, mode: 'insensitive' as const },
            },
        };
        const [memberCount, groupCount] = await Promise.all([
            context.db.collectionMemberGrant.count({ where: memberWhere }),
            context.db.collectionGroupGrant.count({ where: groupWhere }),
        ]);
        const members =
            input.offset < memberCount
                ? await context.db.collectionMemberGrant.findMany({
                      where: memberWhere,
                      orderBy: { memberId: 'asc' },
                      skip: input.offset,
                      take: input.limit,
                      include: {
                          member: {
                              select: { user: { select: { name: true } } },
                          },
                      },
                  })
                : [];
        const groups =
            members.length < input.limit
                ? await context.db.collectionGroupGrant.findMany({
                      where: groupWhere,
                      orderBy: { groupId: 'asc' },
                      skip: Math.max(0, input.offset - memberCount),
                      take: input.limit - members.length,
                      include: { group: { select: { name: true } } },
                  })
                : [];
        return {
            items: [
                ...members.map(
                    ({
                        memberId,
                        member,
                        read,
                        manageDocuments,
                        administer,
                    }) => ({
                        target: { type: 'member' as const, id: memberId },
                        name: member.user.name,
                        permissions: { read, manageDocuments, administer },
                    })
                ),
                ...groups.map(
                    ({
                        groupId,
                        group,
                        read,
                        manageDocuments,
                        administer,
                    }) => ({
                        target: { type: 'group' as const, id: groupId },
                        name: group.name,
                        permissions: { read, manageDocuments, administer },
                    })
                ),
            ],
            total: memberCount + groupCount,
        };
    }
);
