import { oc } from '@orpc/contract';
import { z } from 'zod';
import { organizationAccessV1Contract } from './access';
import { entitlementsV1Schema } from '../superadmin';
export const adminOrganizationsV1Contract = {
    ...organizationAccessV1Contract,
    get: oc
        .route({ method: 'GET', path: '/' })
        .input(z.object({}).default({}))
        .output(
            z.object({
                id: z.string(),
                name: z.string(),
                slug: z.string(),
                logo: z.string().nullable(),
            })
        ),
    features: oc
        .route({ method: 'GET', path: '/features' })
        .input(z.object({}).default({}))
        .output(entitlementsV1Schema),
};
