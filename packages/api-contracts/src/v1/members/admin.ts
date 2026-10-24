import { oc } from '@orpc/contract';
import { z } from 'zod';
import { listWindowFields } from '../list-window';
const member = z.object({
    id: z.string(),
    organizationId: z.string(),
    userId: z.string(),
    role: z.string(),
    createdAt: z.date(),
    avatarColor: z
        .enum(['BLUE', 'EMERALD', 'AMBER', 'VIOLET', 'ROSE', 'CYAN'])
        .nullable(),
    user: z.object({
        id: z.string(),
        name: z.string(),
        email: z.string(),
        image: z.string().nullable(),
    }),
});
export const adminMembersV1Contract = {
    get: oc
        .route({ method: 'GET', path: '/' })
        .input(z.object(listWindowFields).default({}))
        .output(
            z.object({ members: z.array(member), total: z.number().int() })
        ),
    me: oc
        .route({ method: 'GET', path: '/me' })
        .input(z.object({}).default({}))
        .output(member),
};
