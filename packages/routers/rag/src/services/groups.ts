import { ORPCError } from '@orpc/server';
import type { AuthorizedContext } from '@routers/utils/authorized';
import { mutate, audit } from './mutation';
import { permits } from '@repo/auth/permissions';
import { requireCollection } from './access';

export function createGroup(context: AuthorizedContext, name: string) {
    return mutate(context, { ragGroups: ['manage'] }, async (db, actor) => {
        if (
            (await db.organizationGroup.count({
                where: { organizationId: actor.organizationId },
            })) >= 100
        )
            throw new ORPCError('CONFLICT', {
                message: 'The organization group limit is reached.',
            });
        const group = await db.organizationGroup.create({
            data: { organizationId: actor.organizationId, name },
        });
        await audit(db, actor, 'group.create', group.id);
        return { ...group, memberCount: 0 };
    });
}
export function renameGroup(
    context: AuthorizedContext,
    input: { id: string; name: string }
) {
    return mutate(context, { ragGroups: ['manage'] }, async (db, actor) => {
        const group = await db.organizationGroup.findFirst({
            where: { id: input.id, organizationId: actor.organizationId },
        });
        if (!group) throw new ORPCError('NOT_FOUND');
        const result = await db.organizationGroup.update({
            where: { id: group.id },
            data: { name: input.name },
            include: { _count: { select: { members: true } } },
        });
        await audit(db, actor, 'group.rename', group.id);
        return { ...result, memberCount: result._count.members };
    });
}
export function deleteGroup(context: AuthorizedContext, id: string) {
    return mutate(context, { ragGroups: ['manage'] }, async (db, actor) => {
        const group = await db.organizationGroup.findFirst({
            where: { id, organizationId: actor.organizationId },
        });
        if (!group) throw new ORPCError('NOT_FOUND');
        await db.organizationGroup.delete({ where: { id } });
        await audit(db, actor, 'group.delete', id);
        return { success: true as const };
    });
}
/** Adding members can confer collection permissions; only organization group managers may do this. */
export function changeGroupMember(
    context: AuthorizedContext,
    input: { id: string; memberId: string },
    add: boolean
) {
    return mutate(context, { ragGroups: ['manage'] }, async (db, actor) => {
        const group = await db.organizationGroup.findFirst({
            where: { id: input.id, organizationId: actor.organizationId },
        });
        const member = await db.member.findFirst({
            where: { id: input.memberId, organizationId: actor.organizationId },
        });
        if (!group || !member) throw new ORPCError('NOT_FOUND');
        if (add) {
            const grants = await db.collectionGroupGrant.findMany({
                where: {
                    organizationId: actor.organizationId,
                    groupId: group.id,
                    collection: { deletedAt: null },
                },
                select: { collectionId: true },
            });
            if (
                grants.length &&
                !permits(actor.permissions, { ragCollection: ['manageGrants'] })
            )
                throw new ORPCError('FORBIDDEN');
            for (const grant of grants)
                await requireCollection(
                    db,
                    actor,
                    grant.collectionId,
                    'administer'
                );
        }
        await (add
            ? db.groupMember.upsert({
                  where: {
                      ['groupId_memberId']: {
                          groupId: group.id,
                          memberId: member.id,
                      },
                  },
                  create: {
                      organizationId: actor.organizationId,
                      groupId: group.id,
                      memberId: member.id,
                  },
                  update: {},
              })
            : db.groupMember.deleteMany({
                  where: {
                      organizationId: actor.organizationId,
                      groupId: group.id,
                      memberId: member.id,
                  },
              }));
        await audit(
            db,
            actor,
            add ? 'group.member.add' : 'group.member.remove',
            group.id,
            { memberId: member.id }
        );
        return { success: true as const };
    });
}
