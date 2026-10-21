import { oc } from '@orpc/contract';
import { z } from 'zod';
import { id, page, success, principalPage } from './common';
const name = z.string().trim().min(1).max(100);
const group = z.object({
    id,
    name: z.string(),
    createdAt: z.date(),
    updatedAt: z.date(),
    memberCount: z.number().int(),
});
export const groupsContract = {
    memberCandidates: oc
        .route({ method: 'GET', path: '/groups/{id}/member-candidates' })
        .input(page.removeDefault().extend({ id }))
        .output(principalPage),
    list: oc
        .route({ method: 'GET', path: '/groups' })
        .input(page)
        .output(z.object({ items: z.array(group), total: z.number().int() })),
    create: oc
        .route({ method: 'POST', path: '/groups' })
        .input(z.object({ name }).strict())
        .output(group),
    rename: oc
        .route({ method: 'PUT', path: '/groups/{id}' })
        .input(z.object({ id, name }).strict())
        .output(group),
    delete: oc
        .route({ method: 'DELETE', path: '/groups/{id}' })
        .input(z.object({ id }).strict())
        .output(success),
    members: oc
        .route({ method: 'GET', path: '/groups/{id}/members' })
        .input(page.removeDefault().extend({ id }))
        .output(
            z.object({
                items: z.array(z.object({ memberId: id, name: z.string() })),
                total: z.number().int(),
            })
        ),
    addMember: oc
        .route({ method: 'PUT', path: '/groups/{id}/members/{memberId}' })
        .input(z.object({ id, memberId: id }).strict())
        .output(success),
    removeMember: oc
        .route({ method: 'DELETE', path: '/groups/{id}/members/{memberId}' })
        .input(z.object({ id, memberId: id }).strict())
        .output(success),
};
